import { type Tx } from '@aztec/circuit-types';
import { type AztecAddress, type Fr, type FunctionSelector } from '@aztec/circuits.js';
import { computeVarArgsHash } from '@aztec/circuits.js/hash';

export function patchNonRevertibleFn(
  tx: Tx,
  index: number,
  overrides: { address?: AztecAddress; selector: FunctionSelector; args?: Fr[]; msgSender?: AztecAddress },
): { address: AztecAddress; selector: FunctionSelector } {
  return patchFn('endNonRevertibleData', tx, index, overrides);
}

export function patchRevertibleFn(
  tx: Tx,
  index: number,
  overrides: { address?: AztecAddress; selector: FunctionSelector; args?: Fr[]; msgSender?: AztecAddress },
): { address: AztecAddress; selector: FunctionSelector } {
  return patchFn('end', tx, index, overrides);
}

function patchFn(
  where: 'end' | 'endNonRevertibleData',
  tx: Tx,
  index: number,
  overrides: { address?: AztecAddress; selector: FunctionSelector; args?: Fr[]; msgSender?: AztecAddress },
): { address: AztecAddress; selector: FunctionSelector } {
  const fn = tx.enqueuedPublicFunctionCalls.at(-1 * index - 1)!;
  fn.callContext.contractAddress = overrides.address ?? fn.callContext.contractAddress;
  fn.callContext.functionSelector = overrides.selector;
  fn.args = overrides.args ?? fn.args;
  fn.callContext.msgSender = overrides.msgSender ?? fn.callContext.msgSender;
  tx.enqueuedPublicFunctionCalls[index] = fn;

  const request = tx.data.forPublic![where].publicCallStack[index];
  request.callContext.contractAddress = fn.callContext.contractAddress;
  request.callContext = fn.callContext;
  request.argsHash = computeVarArgsHash(fn.args);
  tx.data.forPublic![where].publicCallStack[index] = request;

  return {
    address: fn.callContext.contractAddress,
    selector: fn.callContext.functionSelector,
  };
}
