// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {ApellaBase} from "./base.t.sol";
import {DataStructures} from "@aztec/governance/libraries/DataStructures.sol";
import {Errors} from "@aztec/governance/libraries/Errors.sol";

contract DropProposalTest is ApellaBase {
  modifier givenProposalIsStable() {
    _;
  }

  function test_GivenProposalIsDropped(address _gerousia) external givenProposalIsStable {
    // it revert
    _stateDropped("empty", _gerousia);
    assertEq(apella.getProposal(proposalId).state, DataStructures.ProposalState.Pending);
    assertEq(apella.getProposalState(proposalId), DataStructures.ProposalState.Dropped);
    assertTrue(apella.dropProposal(proposalId));
    assertEq(apella.getProposal(proposalId).state, DataStructures.ProposalState.Dropped);

    vm.expectRevert(abi.encodeWithSelector(Errors.Apella__ProposalAlreadyDropped.selector));
    apella.dropProposal(proposalId);
  }

  function test_GivenProposalIsExecuted(
    address _voter,
    uint256 _totalPower,
    uint256 _votesCast,
    uint256 _yeas
  ) external givenProposalIsStable {
    // it revert
    _stateExecutable("empty", _voter, _totalPower, _votesCast, _yeas);
    assertTrue(apella.execute(proposalId));
    assertEq(apella.getProposal(proposalId).state, DataStructures.ProposalState.Executed);

    vm.expectRevert(abi.encodeWithSelector(Errors.Apella__ProposalCannotBeDropped.selector));
    apella.dropProposal(proposalId);
  }

  modifier givenProposalIsUnstable() {
    _;
  }

  modifier whenGetProposalStateIsNotDropped() {
    _;
    vm.expectRevert(abi.encodeWithSelector(Errors.Apella__ProposalCannotBeDropped.selector));
    apella.dropProposal(proposalId);
  }

  function test_WhenGetProposalStateIsPending()
    external
    givenProposalIsUnstable
    whenGetProposalStateIsNotDropped
  {
    // it revert
    _statePending("empty");
    assertEq(apella.getProposalState(proposalId), DataStructures.ProposalState.Pending);
  }

  function test_WhenGetProposalStateIsActive()
    external
    givenProposalIsUnstable
    whenGetProposalStateIsNotDropped
  {
    // it revert
    _stateActive("empty");
    assertEq(apella.getProposalState(proposalId), DataStructures.ProposalState.Active);
  }

  function test_WhenGetProposalStateIsQueued(
    address _voter,
    uint256 _totalPower,
    uint256 _votesCast,
    uint256 _yeas
  ) external givenProposalIsUnstable whenGetProposalStateIsNotDropped {
    // it revert
    _stateQueued("empty", _voter, _totalPower, _votesCast, _yeas);
    assertEq(apella.getProposalState(proposalId), DataStructures.ProposalState.Queued);
  }

  function test_WhenGetProposalStateIsExecutable(
    address _voter,
    uint256 _totalPower,
    uint256 _votesCast,
    uint256 _yeas
  ) external givenProposalIsUnstable whenGetProposalStateIsNotDropped {
    // it revert
    _stateExecutable("empty", _voter, _totalPower, _votesCast, _yeas);
    assertEq(apella.getProposalState(proposalId), DataStructures.ProposalState.Executable);
  }

  function test_WhenGetProposalStateIsRejected()
    external
    givenProposalIsUnstable
    whenGetProposalStateIsNotDropped
  {
    // it revert
    _stateRejected("empty");
    assertEq(apella.getProposalState(proposalId), DataStructures.ProposalState.Rejected);
  }

  function test_WhenGetProposalStateIsExecuted(
    address _voter,
    uint256 _totalPower,
    uint256 _votesCast,
    uint256 _yeas
  ) external givenProposalIsUnstable whenGetProposalStateIsNotDropped {
    // it revert
    _stateExecutable("empty", _voter, _totalPower, _votesCast, _yeas);
    assertTrue(apella.execute(proposalId));
    assertEq(apella.getProposalState(proposalId), DataStructures.ProposalState.Executed);
  }

  function test_WhenGetProposalStateIsExpired(
    address _voter,
    uint256 _totalPower,
    uint256 _votesCast,
    uint256 _yeas
  ) external givenProposalIsUnstable whenGetProposalStateIsNotDropped {
    // it revert
    _stateExpired("empty", _voter, _totalPower, _votesCast, _yeas);
    assertEq(apella.getProposalState(proposalId), DataStructures.ProposalState.Expired);
  }

  function test_WhenGetProposalStateIsDropped(address _gerousia) external givenProposalIsUnstable {
    // it updates state to Dropped
    // it return true

    _stateDropped("empty", _gerousia);
    assertEq(apella.getProposal(proposalId).state, DataStructures.ProposalState.Pending);
    assertEq(apella.getProposalState(proposalId), DataStructures.ProposalState.Dropped);
    assertTrue(apella.dropProposal(proposalId));
    assertEq(apella.getProposal(proposalId).state, DataStructures.ProposalState.Dropped);
    assertEq(apella.getProposalState(proposalId), DataStructures.ProposalState.Dropped);
  }
}
