import {
  type MerkleTreeWriteOperations,
  type ProcessedTx,
  type ProcessedTxHandler,
  PublicDataWrite,
  PublicKernelPhase,
  SimulationError,
  type TreeInfo,
  type TxValidator,
  mockTx,
  toTxEffect,
} from '@aztec/circuit-types';
import {
  AppendOnlyTreeSnapshot,
  AztecAddress,
  ClientIvcProof,
  ContractStorageRead,
  ContractStorageUpdateRequest,
  Fr,
  Gas,
  GasFees,
  GasSettings,
  GlobalVariables,
  Header,
  MAX_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX,
  MAX_TOTAL_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX,
  PUBLIC_DATA_TREE_HEIGHT,
  PartialStateReference,
  PublicAccumulatedDataBuilder,
  PublicDataTreeLeafPreimage,
  PublicDataUpdateRequest,
  RevertCode,
  StateReference,
} from '@aztec/circuits.js';
import { computePublicDataTreeLeafSlot } from '@aztec/circuits.js/hash';
import { fr, makeSelector } from '@aztec/circuits.js/testing';
import { arrayNonEmptyLength, times } from '@aztec/foundation/collection';
import { type FieldsOf } from '@aztec/foundation/types';
import { openTmpStore } from '@aztec/kv-store/utils';
import { type AppendOnlyTree, Poseidon, StandardTree, newTree } from '@aztec/merkle-tree';
import { type PublicExecutor, WASMSimulator, computeFeePayerBalanceLeafSlot } from '@aztec/simulator';
import { NoopTelemetryClient } from '@aztec/telemetry-client/noop';

import { jest } from '@jest/globals';
import { type MockProxy, mock } from 'jest-mock-extended';

import { PublicExecutionResultBuilder, makeFunctionCall } from '../mocks/fixtures.js';
import { type PublicExecutionResult } from './execution.js';
import { type WorldStateDB } from './public_db_sources.js';
import { RealPublicKernelCircuitSimulator } from './public_kernel.js';
import { type PublicKernelCircuitSimulator } from './public_kernel_circuit_simulator.js';
import { PublicProcessor } from './public_processor.js';

describe('public_processor', () => {
  let db: MockProxy<MerkleTreeWriteOperations>;
  let publicExecutor: MockProxy<PublicExecutor>;
  let worldStateDB: MockProxy<WorldStateDB>;
  let handler: MockProxy<ProcessedTxHandler>;

  let proof: ClientIvcProof;
  let root: Buffer;

  let processor: PublicProcessor;

  beforeEach(() => {
    db = mock<MerkleTreeWriteOperations>();
    publicExecutor = mock<PublicExecutor>();
    worldStateDB = mock<WorldStateDB>();
    handler = mock<ProcessedTxHandler>();

    proof = ClientIvcProof.empty();
    root = Buffer.alloc(32, 5);

    db.getTreeInfo.mockResolvedValue({ root } as TreeInfo);
    worldStateDB.storageRead.mockResolvedValue(Fr.ZERO);
  });

  describe('with mock circuits', () => {
    let publicKernel: MockProxy<PublicKernelCircuitSimulator>;

    beforeEach(() => {
      publicKernel = mock<PublicKernelCircuitSimulator>();
      processor = PublicProcessor.create(
        db,
        publicExecutor,
        publicKernel,
        GlobalVariables.empty(),
        Header.empty(),
        worldStateDB,
        new NoopTelemetryClient(),
      );
    });

    it('skips txs without public execution requests', async function () {
      const tx = mockTx(1, { numberOfNonRevertiblePublicCallRequests: 0, numberOfRevertiblePublicCallRequests: 0 });

      const hash = tx.getTxHash();
      const [processed, failed] = await processor.process([tx], 1, handler);

      expect(processed.length).toBe(1);

      const expected: ProcessedTx = {
        hash,
        data: tx.data.toKernelCircuitPublicInputs(),
        noteEncryptedLogs: tx.noteEncryptedLogs,
        encryptedLogs: tx.encryptedLogs,
        unencryptedLogs: tx.unencryptedLogs,
        clientIvcProof: tx.clientIvcProof,
        isEmpty: false,
        revertReason: undefined,
        avmProvingRequest: undefined,
        gasUsed: {},
        finalPublicDataUpdateRequests: times(
          MAX_TOTAL_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX,
          PublicDataUpdateRequest.empty,
        ),
      };

      expect(processed[0]).toEqual(expected);
      expect(failed).toEqual([]);

      expect(handler.addNewTx).toHaveBeenCalledWith(processed[0]);
    });

    it('returns failed txs without aborting entire operation', async function () {
      publicExecutor.simulate.mockRejectedValue(new SimulationError(`Failed`, []));

      const tx = mockTx(1, { numberOfNonRevertiblePublicCallRequests: 0, numberOfRevertiblePublicCallRequests: 1 });
      const [processed, failed] = await processor.process([tx], 1, handler);

      expect(processed).toEqual([]);
      expect(failed[0].tx).toEqual(tx);
      expect(failed[0].error).toEqual(new SimulationError(`Failed`, []));
      expect(worldStateDB.commit).toHaveBeenCalledTimes(0);
      expect(worldStateDB.rollbackToCommit).toHaveBeenCalledTimes(1);
      expect(handler.addNewTx).toHaveBeenCalledTimes(0);
    });
  });

  describe('with actual circuits', () => {
    let publicKernel: PublicKernelCircuitSimulator;
    let publicDataTree: AppendOnlyTree<Fr>;

    beforeAll(async () => {
      publicDataTree = await newTree(
        StandardTree,
        openTmpStore(),
        new Poseidon(),
        'PublicData',
        Fr,
        PUBLIC_DATA_TREE_HEIGHT,
        1, // Add a default low leaf for the public data hints to be proved against.
      );
    });

    beforeEach(() => {
      const snap = new AppendOnlyTreeSnapshot(
        Fr.fromBuffer(publicDataTree.getRoot(true)),
        Number(publicDataTree.getNumLeaves(true)),
      );

      const header = Header.empty();
      const stateReference = new StateReference(
        header.state.l1ToL2MessageTree,
        new PartialStateReference(header.state.partial.noteHashTree, header.state.partial.nullifierTree, snap),
      );
      // Clone the whole state because somewhere down the line (AbstractPhaseManager) the public data root is modified in the referenced header directly :/
      header.state = StateReference.fromBuffer(stateReference.toBuffer());

      db.getStateReference.mockResolvedValue(stateReference);
      db.getSiblingPath.mockResolvedValue(publicDataTree.getSiblingPath(0n, false));
      db.getPreviousValueIndex.mockResolvedValue({ index: 0n, alreadyPresent: true });
      db.getLeafPreimage.mockResolvedValue(new PublicDataTreeLeafPreimage(new Fr(0), new Fr(0), new Fr(0), 0n));

      publicExecutor.simulate.mockImplementation(request => {
        const result = PublicExecutionResultBuilder.fromPublicExecutionRequest({ request }).build();
        return Promise.resolve(result);
      });

      publicKernel = new RealPublicKernelCircuitSimulator(new WASMSimulator());
      processor = PublicProcessor.create(
        db,
        publicExecutor,
        publicKernel,
        GlobalVariables.from({ ...GlobalVariables.empty(), gasFees: GasFees.default() }),
        header,
        worldStateDB,
        new NoopTelemetryClient(),
      );
    });

    it('runs a tx with enqueued public calls', async function () {
      const tx = mockTx(1, {
        numberOfNonRevertiblePublicCallRequests: 0,
        numberOfRevertiblePublicCallRequests: 2,
        hasLogs: true,
      });

      const [processed, failed] = await processor.process([tx], 1, handler);

      expect(failed.map(f => f.error)).toEqual([]);
      expect(processed).toHaveLength(1);
      expect(processed[0].hash).toEqual(tx.getTxHash());
      expect(processed[0].clientIvcProof).toEqual(proof);
      expect(publicExecutor.simulate).toHaveBeenCalledTimes(2);
      expect(worldStateDB.commit).toHaveBeenCalledTimes(1);
      expect(worldStateDB.rollbackToCommit).toHaveBeenCalledTimes(0);

      // we keep the logs
      expect(processed[0].encryptedLogs.getTotalLogCount()).toBe(6);
      expect(processed[0].unencryptedLogs.getTotalLogCount()).toBe(2);

      expect(handler.addNewTx).toHaveBeenCalledWith(processed[0]);
    });

    it('runs a tx with an enqueued public call with nested execution', async function () {
      const tx = mockTx(1, { numberOfNonRevertiblePublicCallRequests: 0, numberOfRevertiblePublicCallRequests: 1 });
      const request = tx.getRevertiblePublicExecutionRequests()[0];

      const publicExecutionResult = PublicExecutionResultBuilder.fromPublicExecutionRequest({
        request,
        nestedExecutions: [
          PublicExecutionResultBuilder.fromFunctionCall({
            from: request.callContext.contractAddress,
            tx: makeFunctionCall(),
          }).build(),
        ],
      }).build();

      publicExecutor.simulate.mockResolvedValue(publicExecutionResult);

      const [processed, failed] = await processor.process([tx], 1, handler);

      expect(processed).toHaveLength(1);
      expect(processed[0].hash).toEqual(tx.getTxHash());
      expect(processed[0].clientIvcProof).toEqual(proof);
      expect(failed).toHaveLength(0);
      expect(publicExecutor.simulate).toHaveBeenCalledTimes(1);
      // we only call checkpoint after successful "setup"
      expect(worldStateDB.checkpoint).toHaveBeenCalledTimes(0);
      expect(worldStateDB.rollbackToCheckpoint).toHaveBeenCalledTimes(0);
      expect(worldStateDB.commit).toHaveBeenCalledTimes(1);
      expect(worldStateDB.rollbackToCommit).toHaveBeenCalledTimes(0);

      expect(handler.addNewTx).toHaveBeenCalledWith(processed[0]);
    });

    it('does not attempt to overfill a block', async function () {
      const txs = Array.from([1, 2, 3], index =>
        mockTx(index, { numberOfNonRevertiblePublicCallRequests: 0, numberOfRevertiblePublicCallRequests: 1 }),
      );

      // We are passing 3 txs but only 2 can fit in the block
      const [processed, failed] = await processor.process(txs, 2, handler);

      expect(processed).toHaveLength(2);
      expect(processed[0].hash).toEqual(txs[0].getTxHash());
      expect(processed[0].clientIvcProof).toEqual(proof);
      expect(processed[1].hash).toEqual(txs[1].getTxHash());
      expect(processed[1].clientIvcProof).toEqual(proof);
      expect(failed).toHaveLength(0);
      expect(publicExecutor.simulate).toHaveBeenCalledTimes(2);
      expect(worldStateDB.commit).toHaveBeenCalledTimes(2);
      expect(worldStateDB.rollbackToCommit).toHaveBeenCalledTimes(0);

      expect(handler.addNewTx).toHaveBeenCalledWith(processed[0]);
      expect(handler.addNewTx).toHaveBeenCalledWith(processed[1]);
    });

    it('does not send a transaction to the prover if validation fails', async function () {
      const tx = mockTx(1, { numberOfNonRevertiblePublicCallRequests: 0, numberOfRevertiblePublicCallRequests: 1 });

      const txValidator: MockProxy<TxValidator<ProcessedTx>> = mock();
      txValidator.validateTxs.mockRejectedValue([[], [tx]]);

      const [processed, failed] = await processor.process([tx], 1, handler, txValidator);

      expect(processed).toHaveLength(0);
      expect(failed).toHaveLength(1);
      expect(publicExecutor.simulate).toHaveBeenCalledTimes(1);

      expect(handler.addNewTx).toHaveBeenCalledTimes(0);
    });

    it('rolls back app logic db updates on failed public execution, but persists setup', async function () {
      const tx = mockTx(1, {
        hasLogs: true,
        numberOfNonRevertiblePublicCallRequests: 1,
        numberOfRevertiblePublicCallRequests: 1,
        hasPublicTeardownCallRequest: true,
      });

      const nonRevertibleRequests = tx.getNonRevertiblePublicExecutionRequests();
      const revertibleRequests = tx.getRevertiblePublicExecutionRequests();
      const teardownRequest = tx.getPublicTeardownExecutionRequest()!;

      const teardownGas = tx.data.constants.txContext.gasSettings.getTeardownLimits();
      const teardownResultSettings = { startGasLeft: teardownGas, endGasLeft: teardownGas };

      const nestedContractAddress = AztecAddress.fromBigInt(112233n);
      const contractSlotA = fr(0x100);
      const contractSlotB = fr(0x150);
      const contractSlotC = fr(0x200);
      const contractSlotD = fr(0x250);
      const contractSlotE = fr(0x300);
      const contractSlotF = fr(0x350);

      let simulatorCallCount = 0;
      const simulatorResults: PublicExecutionResult[] = [
        // Setup
        PublicExecutionResultBuilder.fromPublicExecutionRequest({
          request: nonRevertibleRequests[0],
          contractStorageUpdateRequests: [new ContractStorageUpdateRequest(contractSlotA, fr(0x101), 11)],
        }).build(),

        // App Logic
        PublicExecutionResultBuilder.fromPublicExecutionRequest({
          request: revertibleRequests[0],
          nestedExecutions: [
            PublicExecutionResultBuilder.fromFunctionCall({
              from: revertibleRequests[0].callContext.contractAddress,
              tx: makeFunctionCall('', nestedContractAddress, makeSelector(5)),
              contractStorageUpdateRequests: [
                new ContractStorageUpdateRequest(contractSlotA, fr(0x102), 13),
                new ContractStorageUpdateRequest(contractSlotB, fr(0x151), 14),
                new ContractStorageUpdateRequest(contractSlotC, fr(0x200), 15),
              ],
            }).build(),
            PublicExecutionResultBuilder.fromFunctionCall({
              from: revertibleRequests[0].callContext.contractAddress,
              tx: makeFunctionCall('', nestedContractAddress, makeSelector(5)),
              revertReason: new SimulationError('Simulation Failed', []),
            }).build(),
          ],
        }).build(),

        // Teardown
        PublicExecutionResultBuilder.fromPublicExecutionRequest({
          request: teardownRequest,
          nestedExecutions: [
            PublicExecutionResultBuilder.fromFunctionCall({
              from: teardownRequest.callContext.contractAddress,
              tx: makeFunctionCall('', nestedContractAddress, makeSelector(5)),
              contractStorageUpdateRequests: [
                new ContractStorageUpdateRequest(contractSlotC, fr(0x201), 16),
                new ContractStorageUpdateRequest(contractSlotD, fr(0x251), 17),
                new ContractStorageUpdateRequest(contractSlotE, fr(0x301), 18),
                new ContractStorageUpdateRequest(contractSlotF, fr(0x351), 19),
              ],
            }).build(teardownResultSettings),
          ],
        }).build(teardownResultSettings),
      ];

      publicExecutor.simulate.mockImplementation(execution => {
        if (simulatorCallCount < simulatorResults.length) {
          return Promise.resolve(simulatorResults[simulatorCallCount++]);
        } else {
          throw new Error(`Unexpected execution request: ${execution}, call count: ${simulatorCallCount}`);
        }
      });

      const innerSpy = jest.spyOn(publicKernel, 'publicKernelCircuitInner');
      const mergeSpy = jest.spyOn(publicKernel, 'publicKernelCircuitMerge');

      const [processed, failed] = await processor.process([tx], 1, handler);

      expect(processed).toHaveLength(1);
      expect(processed[0].hash).toEqual(tx.getTxHash());
      expect(processed[0].clientIvcProof).toEqual(proof);
      expect(failed).toHaveLength(0);

      expect(innerSpy).toHaveBeenCalledTimes(1 + 3 + 2);
      expect(mergeSpy).toHaveBeenCalledTimes(3);
      expect(publicExecutor.simulate).toHaveBeenCalledTimes(3);
      expect(worldStateDB.checkpoint).toHaveBeenCalledTimes(1);
      expect(worldStateDB.rollbackToCheckpoint).toHaveBeenCalledTimes(1);
      expect(worldStateDB.commit).toHaveBeenCalledTimes(1);
      expect(worldStateDB.rollbackToCommit).toHaveBeenCalledTimes(0);

      const txEffect = toTxEffect(processed[0], GasFees.default());
      const numPublicDataWrites = 5;
      expect(arrayNonEmptyLength(txEffect.publicDataWrites, PublicDataWrite.isEmpty)).toEqual(numPublicDataWrites);
      const expectedWrites = [
        new PublicDataWrite(
          computePublicDataTreeLeafSlot(nonRevertibleRequests[0].callContext.contractAddress, contractSlotA),
          fr(0x101),
        ),
        new PublicDataWrite(computePublicDataTreeLeafSlot(nestedContractAddress, contractSlotC), fr(0x201)),
        new PublicDataWrite(computePublicDataTreeLeafSlot(nestedContractAddress, contractSlotD), fr(0x251)),
        new PublicDataWrite(computePublicDataTreeLeafSlot(nestedContractAddress, contractSlotE), fr(0x301)),
        new PublicDataWrite(computePublicDataTreeLeafSlot(nestedContractAddress, contractSlotF), fr(0x351)),
      ];
      expect(txEffect.publicDataWrites.slice(0, numPublicDataWrites)).toEqual(expectedWrites);

      // we keep the non-revertible logs
      expect(txEffect.encryptedLogs.getTotalLogCount()).toBe(3);
      expect(txEffect.unencryptedLogs.getTotalLogCount()).toBe(1);

      expect(handler.addNewTx).toHaveBeenCalledWith(processed[0]);
    });

    it('fails a transaction that reverts in setup', async function () {
      const tx = mockTx(1, {
        numberOfNonRevertiblePublicCallRequests: 1,
        numberOfRevertiblePublicCallRequests: 1,
        hasPublicTeardownCallRequest: true,
      });

      const nonRevertibleRequests = tx.getNonRevertiblePublicExecutionRequests();
      const revertibleRequests = tx.getRevertiblePublicExecutionRequests();
      const teardownRequest = tx.getPublicTeardownExecutionRequest()!;

      const nestedContractAddress = AztecAddress.fromBigInt(112233n);
      const contractSlotA = fr(0x100);
      const contractSlotB = fr(0x150);
      const contractSlotC = fr(0x200);

      let simulatorCallCount = 0;
      const simulatorResults: PublicExecutionResult[] = [
        // Setup
        PublicExecutionResultBuilder.fromPublicExecutionRequest({
          request: nonRevertibleRequests[0],
          contractStorageUpdateRequests: [new ContractStorageUpdateRequest(contractSlotA, fr(0x101), 11)],
          nestedExecutions: [
            PublicExecutionResultBuilder.fromFunctionCall({
              from: nonRevertibleRequests[0].callContext.contractAddress,
              tx: makeFunctionCall('', nestedContractAddress, makeSelector(5)),
              contractStorageUpdateRequests: [
                new ContractStorageUpdateRequest(contractSlotA, fr(0x102), 12),
                new ContractStorageUpdateRequest(contractSlotB, fr(0x151), 13),
              ],
            }).build(),
            PublicExecutionResultBuilder.fromFunctionCall({
              from: nonRevertibleRequests[0].callContext.contractAddress,
              tx: makeFunctionCall('', nestedContractAddress, makeSelector(5)),
              revertReason: new SimulationError('Simulation Failed', []),
            }).build(),
          ],
        }).build(),

        // App Logic
        PublicExecutionResultBuilder.fromPublicExecutionRequest({
          request: revertibleRequests[0],
        }).build(),

        // Teardown
        PublicExecutionResultBuilder.fromPublicExecutionRequest({
          request: teardownRequest,
          nestedExecutions: [
            PublicExecutionResultBuilder.fromFunctionCall({
              from: teardownRequest.callContext.contractAddress,
              tx: makeFunctionCall('', nestedContractAddress, makeSelector(5)),
              contractStorageUpdateRequests: [new ContractStorageUpdateRequest(contractSlotC, fr(0x202), 16)],
            }).build(),
          ],
        }).build(),
      ];

      publicExecutor.simulate.mockImplementation(execution => {
        if (simulatorCallCount < simulatorResults.length) {
          return Promise.resolve(simulatorResults[simulatorCallCount++]);
        } else {
          throw new Error(`Unexpected execution request: ${execution}, call count: ${simulatorCallCount}`);
        }
      });

      const innerSpy = jest.spyOn(publicKernel, 'publicKernelCircuitInner');
      const mergeSpy = jest.spyOn(publicKernel, 'publicKernelCircuitMerge');

      const [processed, failed] = await processor.process([tx], 1, handler);

      expect(processed).toHaveLength(0);
      expect(failed).toHaveLength(1);
      expect(failed[0].tx.getTxHash()).toEqual(tx.getTxHash());

      expect(innerSpy).toHaveBeenCalledTimes(3);
      expect(mergeSpy).toHaveBeenCalledTimes(0);
      expect(publicExecutor.simulate).toHaveBeenCalledTimes(1);

      expect(worldStateDB.checkpoint).toHaveBeenCalledTimes(0);
      expect(worldStateDB.rollbackToCheckpoint).toHaveBeenCalledTimes(0);
      expect(worldStateDB.commit).toHaveBeenCalledTimes(0);
      expect(worldStateDB.rollbackToCommit).toHaveBeenCalledTimes(1);

      expect(handler.addNewTx).toHaveBeenCalledTimes(0);
    });

    it('includes a transaction that reverts in teardown', async function () {
      const tx = mockTx(1, {
        hasLogs: true,
        numberOfNonRevertiblePublicCallRequests: 1,
        numberOfRevertiblePublicCallRequests: 1,
        hasPublicTeardownCallRequest: true,
      });

      const nonRevertibleRequests = tx.getNonRevertiblePublicExecutionRequests();
      const revertibleRequests = tx.getRevertiblePublicExecutionRequests();
      const teardownRequest = tx.getPublicTeardownExecutionRequest()!;

      const teardownGas = tx.data.constants.txContext.gasSettings.getTeardownLimits();
      const teardownResultSettings = { startGasLeft: teardownGas, endGasLeft: teardownGas };

      const nestedContractAddress = AztecAddress.fromBigInt(112233n);
      const contractSlotA = fr(0x100);
      const contractSlotB = fr(0x150);
      const contractSlotC = fr(0x200);

      let simulatorCallCount = 0;
      const simulatorResults: PublicExecutionResult[] = [
        // Setup
        PublicExecutionResultBuilder.fromPublicExecutionRequest({
          request: nonRevertibleRequests[0],
          contractStorageUpdateRequests: [new ContractStorageUpdateRequest(contractSlotA, fr(0x101), 11)],
          nestedExecutions: [
            PublicExecutionResultBuilder.fromFunctionCall({
              from: nonRevertibleRequests[0].callContext.contractAddress,
              tx: makeFunctionCall('', nestedContractAddress, makeSelector(5)),
              contractStorageUpdateRequests: [
                new ContractStorageUpdateRequest(contractSlotA, fr(0x102), 12),
                new ContractStorageUpdateRequest(contractSlotB, fr(0x151), 13),
              ],
            }).build(),
          ],
        }).build(),

        // App Logic
        PublicExecutionResultBuilder.fromPublicExecutionRequest({
          request: revertibleRequests[0],
          contractStorageUpdateRequests: [
            new ContractStorageUpdateRequest(contractSlotB, fr(0x152), 14),
            new ContractStorageUpdateRequest(contractSlotC, fr(0x201), 15),
          ],
        }).build(),

        // Teardown
        PublicExecutionResultBuilder.fromPublicExecutionRequest({
          request: teardownRequest,
          nestedExecutions: [
            PublicExecutionResultBuilder.fromFunctionCall({
              from: teardownRequest.callContext.contractAddress,
              tx: makeFunctionCall('', nestedContractAddress, makeSelector(5)),
              contractStorageUpdateRequests: [new ContractStorageUpdateRequest(contractSlotC, fr(0x202), 16)],
            }).build(teardownResultSettings),
            PublicExecutionResultBuilder.fromFunctionCall({
              from: teardownRequest.callContext.contractAddress,
              tx: makeFunctionCall('', nestedContractAddress, makeSelector(5)),
              contractStorageUpdateRequests: [new ContractStorageUpdateRequest(contractSlotC, fr(0x202), 17)],
              revertReason: new SimulationError('Simulation Failed', []),
            }).build(teardownResultSettings),
          ],
        }).build(teardownResultSettings),
      ];

      publicExecutor.simulate.mockImplementation(execution => {
        if (simulatorCallCount < simulatorResults.length) {
          return Promise.resolve(simulatorResults[simulatorCallCount++]);
        } else {
          throw new Error(`Unexpected execution request: ${execution}, call count: ${simulatorCallCount}`);
        }
      });

      const innerSpy = jest.spyOn(publicKernel, 'publicKernelCircuitInner');
      const mergeSpy = jest.spyOn(publicKernel, 'publicKernelCircuitMerge');

      const [processed, failed] = await processor.process([tx], 1, handler);

      expect(processed).toHaveLength(1);
      expect(processed[0].hash).toEqual(tx.getTxHash());
      expect(processed[0].clientIvcProof).toEqual(proof);
      expect(failed).toHaveLength(0);

      expect(innerSpy).toHaveBeenCalledTimes(2 + 1 + 3);
      expect(mergeSpy).toHaveBeenCalledTimes(3);
      expect(publicExecutor.simulate).toHaveBeenCalledTimes(3);
      expect(worldStateDB.checkpoint).toHaveBeenCalledTimes(1);
      expect(worldStateDB.rollbackToCheckpoint).toHaveBeenCalledTimes(1);
      expect(worldStateDB.commit).toHaveBeenCalledTimes(1);
      expect(worldStateDB.rollbackToCommit).toHaveBeenCalledTimes(0);

      const txEffect = toTxEffect(processed[0], GasFees.default());
      const numPublicDataWrites = 3;
      expect(arrayNonEmptyLength(txEffect.publicDataWrites, PublicDataWrite.isEmpty)).toBe(numPublicDataWrites);
      expect(txEffect.publicDataWrites.slice(0, numPublicDataWrites)).toEqual([
        new PublicDataWrite(
          computePublicDataTreeLeafSlot(nonRevertibleRequests[0].callContext.contractAddress, contractSlotA),
          fr(0x101),
        ),
        new PublicDataWrite(computePublicDataTreeLeafSlot(nestedContractAddress, contractSlotA), fr(0x102)),
        new PublicDataWrite(computePublicDataTreeLeafSlot(nestedContractAddress, contractSlotB), fr(0x151)),
      ]);

      // we keep the non-revertible logs
      expect(txEffect.encryptedLogs.getTotalLogCount()).toBe(3);
      expect(txEffect.unencryptedLogs.getTotalLogCount()).toBe(1);

      expect(processed[0].data.revertCode).toEqual(RevertCode.TEARDOWN_REVERTED);

      expect(handler.addNewTx).toHaveBeenCalledWith(processed[0]);
    });

    it('includes a transaction that reverts in app logic and teardown', async function () {
      const tx = mockTx(1, {
        hasLogs: true,
        numberOfNonRevertiblePublicCallRequests: 1,
        numberOfRevertiblePublicCallRequests: 1,
        hasPublicTeardownCallRequest: true,
      });

      const nonRevertibleRequests = tx.getNonRevertiblePublicExecutionRequests();
      const revertibleRequests = tx.getRevertiblePublicExecutionRequests();
      const teardownRequest = tx.getPublicTeardownExecutionRequest()!;

      const teardownGas = tx.data.constants.txContext.gasSettings.getTeardownLimits();
      const teardownResultSettings = { startGasLeft: teardownGas, endGasLeft: teardownGas };

      const nestedContractAddress = AztecAddress.fromBigInt(112233n);
      const contractSlotA = fr(0x100);
      const contractSlotB = fr(0x150);
      const contractSlotC = fr(0x200);

      let simulatorCallCount = 0;
      const simulatorResults: PublicExecutionResult[] = [
        // Setup
        PublicExecutionResultBuilder.fromPublicExecutionRequest({
          request: nonRevertibleRequests[0],
          contractStorageUpdateRequests: [new ContractStorageUpdateRequest(contractSlotA, fr(0x101), 11)],
          nestedExecutions: [
            PublicExecutionResultBuilder.fromFunctionCall({
              from: nonRevertibleRequests[0].callContext.contractAddress,
              tx: makeFunctionCall('', nestedContractAddress, makeSelector(5)),
              contractStorageUpdateRequests: [
                new ContractStorageUpdateRequest(contractSlotA, fr(0x102), 12),
                new ContractStorageUpdateRequest(contractSlotB, fr(0x151), 13),
              ],
            }).build(),
          ],
        }).build(),

        // App Logic
        PublicExecutionResultBuilder.fromPublicExecutionRequest({
          request: revertibleRequests[0],
          contractStorageUpdateRequests: [
            new ContractStorageUpdateRequest(contractSlotB, fr(0x152), 14),
            new ContractStorageUpdateRequest(contractSlotC, fr(0x201), 15),
          ],
          revertReason: new SimulationError('Simulation Failed', []),
        }).build(),

        // Teardown
        PublicExecutionResultBuilder.fromPublicExecutionRequest({
          request: teardownRequest,
          nestedExecutions: [
            PublicExecutionResultBuilder.fromFunctionCall({
              from: teardownRequest.callContext.contractAddress,
              tx: makeFunctionCall('', nestedContractAddress, makeSelector(5)),
              contractStorageUpdateRequests: [new ContractStorageUpdateRequest(contractSlotC, fr(0x202), 16)],
            }).build(teardownResultSettings),
            PublicExecutionResultBuilder.fromFunctionCall({
              from: teardownRequest.callContext.contractAddress,
              tx: makeFunctionCall('', nestedContractAddress, makeSelector(5)),
              contractStorageUpdateRequests: [new ContractStorageUpdateRequest(contractSlotC, fr(0x202), 16)],
              revertReason: new SimulationError('Simulation Failed', []),
            }).build(teardownResultSettings),
          ],
        }).build(teardownResultSettings),
      ];

      publicExecutor.simulate.mockImplementation(execution => {
        if (simulatorCallCount < simulatorResults.length) {
          return Promise.resolve(simulatorResults[simulatorCallCount++]);
        } else {
          throw new Error(`Unexpected execution request: ${execution}, call count: ${simulatorCallCount}`);
        }
      });

      const innerSpy = jest.spyOn(publicKernel, 'publicKernelCircuitInner');
      const mergeSpy = jest.spyOn(publicKernel, 'publicKernelCircuitMerge');

      const [processed, failed] = await processor.process([tx], 1, handler);

      expect(processed).toHaveLength(1);
      expect(processed[0].hash).toEqual(tx.getTxHash());
      expect(processed[0].clientIvcProof).toEqual(proof);
      expect(failed).toHaveLength(0);

      expect(innerSpy).toHaveBeenCalledTimes(2 + 1 + 3);
      expect(mergeSpy).toHaveBeenCalledTimes(3);
      expect(publicExecutor.simulate).toHaveBeenCalledTimes(3);
      expect(worldStateDB.checkpoint).toHaveBeenCalledTimes(1);
      expect(worldStateDB.rollbackToCheckpoint).toHaveBeenCalledTimes(2);
      expect(worldStateDB.commit).toHaveBeenCalledTimes(1);
      expect(worldStateDB.rollbackToCommit).toHaveBeenCalledTimes(0);

      const txEffect = toTxEffect(processed[0], GasFees.default());
      const numPublicDataWrites = 3;
      expect(arrayNonEmptyLength(txEffect.publicDataWrites, PublicDataWrite.isEmpty)).toBe(numPublicDataWrites);
      expect(txEffect.publicDataWrites.slice(0, numPublicDataWrites)).toEqual([
        new PublicDataWrite(
          computePublicDataTreeLeafSlot(nonRevertibleRequests[0].callContext.contractAddress, contractSlotA),
          fr(0x101),
        ),
        new PublicDataWrite(computePublicDataTreeLeafSlot(nestedContractAddress, contractSlotA), fr(0x102)),
        new PublicDataWrite(computePublicDataTreeLeafSlot(nestedContractAddress, contractSlotB), fr(0x151)),
      ]);

      // we keep the non-revertible logs
      expect(txEffect.encryptedLogs.getTotalLogCount()).toBe(3);
      expect(txEffect.unencryptedLogs.getTotalLogCount()).toBe(1);

      expect(processed[0].data.revertCode).toEqual(RevertCode.BOTH_REVERTED);

      expect(handler.addNewTx).toHaveBeenCalledWith(processed[0]);
    });

    it('runs a tx with all phases', async function () {
      const tx = mockTx(1, {
        numberOfNonRevertiblePublicCallRequests: 1,
        numberOfRevertiblePublicCallRequests: 1,
        hasPublicTeardownCallRequest: true,
      });

      const nonRevertibleRequests = tx.getNonRevertiblePublicExecutionRequests();
      const revertibleRequests = tx.getRevertiblePublicExecutionRequests();
      const teardownRequest = tx.getPublicTeardownExecutionRequest()!;

      // Keep gas numbers MAX_L2_GAS_PER_ENQUEUED_CALL or the logic below has to get weird
      const gasLimits = Gas.from({ l2Gas: 1e6, daGas: 1e6 });
      const teardownGas = Gas.from({ l2Gas: 1e5, daGas: 1e5 });
      tx.data.constants.txContext.gasSettings = GasSettings.from({
        gasLimits: gasLimits,
        teardownGasLimits: teardownGas,
        inclusionFee: new Fr(1e4),
        maxFeesPerGas: { feePerDaGas: new Fr(10), feePerL2Gas: new Fr(10) },
      });

      // Private kernel tail to public pushes teardown gas allocation into revertible gas used
      tx.data.forPublic!.end = PublicAccumulatedDataBuilder.fromPublicAccumulatedData(tx.data.forPublic!.end)
        .withGasUsed(teardownGas)
        .build();
      tx.data.forPublic!.endNonRevertibleData = PublicAccumulatedDataBuilder.fromPublicAccumulatedData(
        tx.data.forPublic!.endNonRevertibleData,
      )
        .withGasUsed(Gas.empty())
        .build();

      const nestedContractAddress = revertibleRequests[0].callContext.contractAddress;
      const contractSlotA = fr(0x100);
      const contractSlotB = fr(0x150);
      const contractSlotC = fr(0x200);

      let simulatorCallCount = 0;

      // Keep gas numbers below MAX_L2_GAS_PER_ENQUEUED_CALL or we need
      // to separately compute available start gas and "effective" start gas
      // for each enqueued call after applying that max.
      const initialGas = gasLimits.sub(teardownGas);
      const setupGasUsed = Gas.from({ l2Gas: 1e4 });
      const appGasUsed = Gas.from({ l2Gas: 2e4, daGas: 2e4 });
      const teardownGasUsed = Gas.from({ l2Gas: 3e4, daGas: 3e4 });
      const afterSetupGas = initialGas.sub(setupGasUsed);
      const afterAppGas = afterSetupGas.sub(appGasUsed);
      const afterTeardownGas = teardownGas.sub(teardownGasUsed);

      // Total gas used is the sum of teardown gas allocation plus all expenditures along the way,
      // without including the gas used in the teardown phase (since that's consumed entirely up front).
      const expectedTotalGasUsed = teardownGas.add(setupGasUsed).add(appGasUsed);

      // Inclusion fee plus block gas fees times total gas used
      const expectedTxFee =
        tx.data.constants.txContext.gasSettings.inclusionFee.toNumber() +
        expectedTotalGasUsed.l2Gas * 1 +
        expectedTotalGasUsed.daGas * 1;
      const transactionFee = new Fr(expectedTxFee);

      const simulatorResults: PublicExecutionResult[] = [
        // Setup
        PublicExecutionResultBuilder.fromPublicExecutionRequest({ request: nonRevertibleRequests[0] }).build({
          startGasLeft: initialGas,
          endGasLeft: afterSetupGas,
        }),

        // App Logic
        PublicExecutionResultBuilder.fromPublicExecutionRequest({
          request: revertibleRequests[0],
          contractStorageUpdateRequests: [
            new ContractStorageUpdateRequest(contractSlotA, fr(0x101), 10),
            new ContractStorageUpdateRequest(contractSlotB, fr(0x151), 11),
          ],
          contractStorageReads: [new ContractStorageRead(contractSlotA, fr(0x100), 19)],
        }).build({
          startGasLeft: afterSetupGas,
          endGasLeft: afterAppGas,
        }),

        // Teardown
        PublicExecutionResultBuilder.fromPublicExecutionRequest({
          request: teardownRequest,
          nestedExecutions: [
            PublicExecutionResultBuilder.fromFunctionCall({
              from: teardownRequest.callContext.contractAddress,
              tx: makeFunctionCall('', nestedContractAddress, makeSelector(5)),
              contractStorageUpdateRequests: [
                new ContractStorageUpdateRequest(contractSlotA, fr(0x103), 16),
                new ContractStorageUpdateRequest(contractSlotC, fr(0x201), 17),
              ],
              contractStorageReads: [new ContractStorageRead(contractSlotA, fr(0x102), 15)],
            }).build({ startGasLeft: teardownGas, endGasLeft: teardownGas, transactionFee }),
            PublicExecutionResultBuilder.fromFunctionCall({
              from: teardownRequest.callContext.contractAddress,
              tx: makeFunctionCall('', nestedContractAddress, makeSelector(5)),
              contractStorageUpdateRequests: [
                new ContractStorageUpdateRequest(contractSlotA, fr(0x102), 13),
                new ContractStorageUpdateRequest(contractSlotB, fr(0x152), 14),
              ],
              contractStorageReads: [new ContractStorageRead(contractSlotA, fr(0x101), 12)],
            }).build({ startGasLeft: teardownGas, endGasLeft: teardownGas, transactionFee }),
          ],
        }).build({
          startGasLeft: teardownGas,
          endGasLeft: afterTeardownGas,
          transactionFee,
        }),
      ];

      publicExecutor.simulate.mockImplementation(execution => {
        if (simulatorCallCount < simulatorResults.length) {
          const result = simulatorResults[simulatorCallCount++];
          return Promise.resolve(result);
        } else {
          throw new Error(`Unexpected execution request: ${execution}, call count: ${simulatorCallCount}`);
        }
      });

      const innerSpy = jest.spyOn(publicKernel, 'publicKernelCircuitInner');
      const mergeSpy = jest.spyOn(publicKernel, 'publicKernelCircuitMerge');
      const tailSpy = jest.spyOn(publicKernel, 'publicKernelCircuitTail');

      const [processed, failed] = await processor.process([tx], 1, handler);

      expect(processed).toHaveLength(1);
      expect(processed[0].hash).toEqual(tx.getTxHash());
      expect(processed[0].clientIvcProof).toEqual(proof);
      expect(failed).toHaveLength(0);

      expect(innerSpy).toHaveBeenCalledTimes(1 + 1 + 3);
      expect(mergeSpy).toHaveBeenCalledTimes(3);
      expect(tailSpy).toHaveBeenCalledTimes(1);

      const expectedSimulateCall = (availableGas: Partial<FieldsOf<Gas>>, txFee: number) => [
        expect.anything(), // PublicExecution
        expect.anything(), // GlobalVariables
        Gas.from(availableGas),
        expect.anything(), // TxContext
        expect.anything(), // pendingNullifiers
        new Fr(txFee),
        expect.anything(), // SideEffectCounter
        expect.anything(), // PublicValidationRequestArrayLengths
        expect.anything(), // PublicAccumulatedDataArrayLengths
      ];

      expect(publicExecutor.simulate).toHaveBeenCalledTimes(3);
      expect(publicExecutor.simulate).toHaveBeenNthCalledWith(1, ...expectedSimulateCall(initialGas, 0));
      expect(publicExecutor.simulate).toHaveBeenNthCalledWith(2, ...expectedSimulateCall(afterSetupGas, 0));
      expect(publicExecutor.simulate).toHaveBeenNthCalledWith(3, ...expectedSimulateCall(teardownGas, expectedTxFee));

      expect(worldStateDB.checkpoint).toHaveBeenCalledTimes(1);
      expect(worldStateDB.rollbackToCheckpoint).toHaveBeenCalledTimes(0);
      expect(worldStateDB.commit).toHaveBeenCalledTimes(1);
      expect(worldStateDB.rollbackToCommit).toHaveBeenCalledTimes(0);

      expect(processed[0].data.end.gasUsed).toEqual(Gas.from(expectedTotalGasUsed));
      expect(processed[0].gasUsed[PublicKernelPhase.SETUP]).toEqual(setupGasUsed);
      expect(processed[0].gasUsed[PublicKernelPhase.APP_LOGIC]).toEqual(appGasUsed);
      expect(processed[0].gasUsed[PublicKernelPhase.TEARDOWN]).toEqual(teardownGasUsed);

      const txEffect = toTxEffect(processed[0], GasFees.default());
      const numPublicDataWrites = 3;
      expect(arrayNonEmptyLength(txEffect.publicDataWrites, PublicDataWrite.isEmpty)).toEqual(numPublicDataWrites);
      expect(txEffect.publicDataWrites.slice(0, numPublicDataWrites)).toEqual([
        new PublicDataWrite(computePublicDataTreeLeafSlot(nestedContractAddress, contractSlotA), fr(0x103)),
        new PublicDataWrite(computePublicDataTreeLeafSlot(nestedContractAddress, contractSlotC), fr(0x201)),
        new PublicDataWrite(computePublicDataTreeLeafSlot(nestedContractAddress, contractSlotB), fr(0x152)),
      ]);
      expect(txEffect.encryptedLogs.getTotalLogCount()).toBe(0);
      expect(txEffect.unencryptedLogs.getTotalLogCount()).toBe(0);

      expect(handler.addNewTx).toHaveBeenCalledWith(processed[0]);
    });

    it('runs a tx with only teardown', async function () {
      const tx = mockTx(1, {
        numberOfNonRevertiblePublicCallRequests: 0,
        numberOfRevertiblePublicCallRequests: 0,
        hasPublicTeardownCallRequest: true,
      });

      const teardownRequest = tx.getPublicTeardownExecutionRequest()!;

      const gasLimits = Gas.from({ l2Gas: 1e9, daGas: 1e9 });
      const teardownGas = Gas.from({ l2Gas: 1e7, daGas: 1e7 });
      tx.data.constants.txContext.gasSettings = GasSettings.from({
        gasLimits: gasLimits,
        teardownGasLimits: teardownGas,
        inclusionFee: new Fr(1e4),
        maxFeesPerGas: { feePerDaGas: new Fr(10), feePerL2Gas: new Fr(10) },
      });

      // Private kernel tail to public pushes teardown gas allocation into revertible gas used
      tx.data.forPublic!.end = PublicAccumulatedDataBuilder.fromPublicAccumulatedData(tx.data.forPublic!.end)
        .withGasUsed(teardownGas)
        .build();
      tx.data.forPublic!.endNonRevertibleData = PublicAccumulatedDataBuilder.fromPublicAccumulatedData(
        tx.data.forPublic!.endNonRevertibleData,
      )
        .withGasUsed(Gas.empty())
        .build();

      let simulatorCallCount = 0;
      const txOverhead = 1e4;
      const expectedTxFee = txOverhead + teardownGas.l2Gas * 1 + teardownGas.daGas * 1;
      const transactionFee = new Fr(expectedTxFee);
      const teardownGasUsed = Gas.from({ l2Gas: 1e6, daGas: 1e6 });

      const simulatorResults: PublicExecutionResult[] = [
        // Teardown
        PublicExecutionResultBuilder.fromPublicExecutionRequest({
          request: teardownRequest,
          nestedExecutions: [],
        }).build({
          startGasLeft: teardownGas,
          endGasLeft: teardownGas.sub(teardownGasUsed),
          transactionFee,
        }),
      ];

      publicExecutor.simulate.mockImplementation(execution => {
        if (simulatorCallCount < simulatorResults.length) {
          const result = simulatorResults[simulatorCallCount++];
          return Promise.resolve(result);
        } else {
          throw new Error(`Unexpected execution request: ${execution}, call count: ${simulatorCallCount}`);
        }
      });

      const innerSpy = jest.spyOn(publicKernel, 'publicKernelCircuitInner');
      const mergeSpy = jest.spyOn(publicKernel, 'publicKernelCircuitMerge');
      const tailSpy = jest.spyOn(publicKernel, 'publicKernelCircuitTail');

      const [processed, failed] = await processor.process([tx], 1, handler);

      expect(processed).toHaveLength(1);
      expect(processed[0].hash).toEqual(tx.getTxHash());
      expect(processed[0].clientIvcProof).toEqual(proof);
      expect(failed).toHaveLength(0);

      expect(innerSpy).toHaveBeenCalledTimes(1);
      expect(mergeSpy).toHaveBeenCalledTimes(1);
      expect(tailSpy).toHaveBeenCalledTimes(1);
    });

    describe('with fee payer', () => {
      it('injects balance update with no public calls', async function () {
        const feePayer = AztecAddress.random();
        const initialBalance = BigInt(1e12);
        const inclusionFee = 100n;
        const tx = mockTx(1, {
          numberOfNonRevertiblePublicCallRequests: 0,
          numberOfRevertiblePublicCallRequests: 0,
          feePayer,
        });

        tx.data.constants.txContext.gasSettings = GasSettings.from({
          ...GasSettings.default(),
          inclusionFee: new Fr(inclusionFee),
        });

        worldStateDB.storageRead.mockResolvedValue(new Fr(initialBalance));
        worldStateDB.storageWrite.mockImplementation((address: AztecAddress, slot: Fr) =>
          Promise.resolve(computePublicDataTreeLeafSlot(address, slot).toBigInt()),
        );

        const [processed, failed] = await processor.process([tx], 1, handler);

        expect(failed.map(f => f.error)).toEqual([]);
        expect(processed).toHaveLength(1);
        expect(publicExecutor.simulate).toHaveBeenCalledTimes(0);
        expect(worldStateDB.commit).toHaveBeenCalledTimes(1);
        expect(worldStateDB.rollbackToCommit).toHaveBeenCalledTimes(0);
        expect(worldStateDB.storageWrite).toHaveBeenCalledTimes(1);
        expect(processed[0].data.feePayer).toEqual(feePayer);
        expect(processed[0].finalPublicDataUpdateRequests[MAX_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX]).toEqual(
          PublicDataUpdateRequest.from({
            leafIndex: computeFeePayerBalanceLeafSlot(feePayer),
            newValue: new Fr(initialBalance - inclusionFee),
            sideEffectCounter: 0,
          }),
        );

        expect(handler.addNewTx).toHaveBeenCalledWith(processed[0]);
      });

      it('injects balance update with public enqueued call', async function () {
        const feePayer = AztecAddress.random();
        const initialBalance = BigInt(1e12);
        const inclusionFee = 100n;
        const tx = mockTx(1, {
          numberOfNonRevertiblePublicCallRequests: 0,
          numberOfRevertiblePublicCallRequests: 2,
          feePayer,
        });

        tx.data.constants.txContext.gasSettings = GasSettings.from({
          ...GasSettings.default(),
          inclusionFee: new Fr(inclusionFee),
        });

        worldStateDB.storageRead.mockResolvedValue(new Fr(initialBalance));
        worldStateDB.storageWrite.mockImplementation((address: AztecAddress, slot: Fr) =>
          Promise.resolve(computePublicDataTreeLeafSlot(address, slot).toBigInt()),
        );

        const [processed, failed] = await processor.process([tx], 1, handler);

        expect(failed.map(f => f.error)).toEqual([]);
        expect(processed).toHaveLength(1);
        expect(processed[0].hash).toEqual(tx.getTxHash());
        expect(processed[0].clientIvcProof).toEqual(proof);
        expect(publicExecutor.simulate).toHaveBeenCalledTimes(2);
        expect(worldStateDB.commit).toHaveBeenCalledTimes(1);
        expect(worldStateDB.rollbackToCommit).toHaveBeenCalledTimes(0);
        expect(worldStateDB.storageWrite).toHaveBeenCalledTimes(1);
        expect(processed[0].data.feePayer).toEqual(feePayer);
        expect(processed[0].finalPublicDataUpdateRequests[MAX_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX]).toEqual(
          PublicDataUpdateRequest.from({
            leafIndex: computeFeePayerBalanceLeafSlot(feePayer),
            newValue: new Fr(initialBalance - inclusionFee),
            sideEffectCounter: 0,
          }),
        );

        expect(handler.addNewTx).toHaveBeenCalledWith(processed[0]);
      });

      it('tweaks existing balance update from claim', async function () {
        const feePayer = AztecAddress.random();
        const initialBalance = BigInt(1e12);
        const inclusionFee = 100n;
        const tx = mockTx(1, {
          numberOfNonRevertiblePublicCallRequests: 0,
          numberOfRevertiblePublicCallRequests: 2,
          feePayer,
        });

        tx.data.constants.txContext.gasSettings = GasSettings.from({
          ...GasSettings.default(),
          inclusionFee: new Fr(inclusionFee),
        });

        worldStateDB.storageRead.mockResolvedValue(Fr.ZERO);
        worldStateDB.storageWrite.mockImplementation((address: AztecAddress, slot: Fr) =>
          Promise.resolve(computePublicDataTreeLeafSlot(address, slot).toBigInt()),
        );

        tx.data.publicInputs.end.publicDataUpdateRequests[0] = PublicDataUpdateRequest.from({
          leafIndex: computeFeePayerBalanceLeafSlot(feePayer),
          newValue: new Fr(initialBalance),
          sideEffectCounter: 0,
        });

        const [processed, failed] = await processor.process([tx], 1, handler);

        expect(failed.map(f => f.error)).toEqual([]);
        expect(processed).toHaveLength(1);
        expect(processed[0].hash).toEqual(tx.getTxHash());
        expect(processed[0].clientIvcProof).toEqual(proof);
        expect(publicExecutor.simulate).toHaveBeenCalledTimes(2);
        expect(worldStateDB.commit).toHaveBeenCalledTimes(1);
        expect(worldStateDB.rollbackToCommit).toHaveBeenCalledTimes(0);
        expect(worldStateDB.storageWrite).toHaveBeenCalledTimes(1);
        expect(processed[0].data.feePayer).toEqual(feePayer);
        expect(processed[0].finalPublicDataUpdateRequests[0]).toEqual(
          PublicDataUpdateRequest.from({
            leafIndex: computeFeePayerBalanceLeafSlot(feePayer),
            newValue: new Fr(initialBalance - inclusionFee),
            sideEffectCounter: 0,
          }),
        );

        expect(handler.addNewTx).toHaveBeenCalledWith(processed[0]);
      });

      it('rejects tx if fee payer has not enough balance', async function () {
        const feePayer = AztecAddress.random();
        const initialBalance = 1n;
        const inclusionFee = 100n;
        const tx = mockTx(1, {
          numberOfNonRevertiblePublicCallRequests: 0,
          numberOfRevertiblePublicCallRequests: 0,
          feePayer,
        });

        tx.data.constants.txContext.gasSettings = GasSettings.from({
          ...GasSettings.default(),
          inclusionFee: new Fr(inclusionFee),
        });

        worldStateDB.storageRead.mockResolvedValue(new Fr(initialBalance));
        worldStateDB.storageWrite.mockImplementation((address: AztecAddress, slot: Fr) =>
          Promise.resolve(computePublicDataTreeLeafSlot(address, slot).toBigInt()),
        );

        const [processed, failed] = await processor.process([tx], 1, handler);

        expect(processed).toHaveLength(0);
        expect(failed).toHaveLength(1);
        expect(failed[0].error.message).toMatch(/Not enough balance/i);
        expect(publicExecutor.simulate).toHaveBeenCalledTimes(0);
        expect(worldStateDB.commit).toHaveBeenCalledTimes(0);
        expect(worldStateDB.rollbackToCommit).toHaveBeenCalledTimes(0);
        expect(worldStateDB.storageWrite).toHaveBeenCalledTimes(0);
      });
    });
  });
});
