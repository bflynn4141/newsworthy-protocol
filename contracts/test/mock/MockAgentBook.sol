// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IAgentBook} from "../../src/interfaces/IAgentBook.sol";

/// @title Mock AgentBook
/// @notice A test double for IAgentBook that lets tests set humanId mappings directly.
contract MockAgentBook is IAgentBook {
    mapping(address => uint256) public humanIds;

    function setHumanId(address agent, uint256 humanId) external {
        humanIds[agent] = humanId;
    }

    function lookupHuman(address agent) external view override returns (uint256) {
        return humanIds[agent];
    }

    function getNextNonce(address) external pure override returns (uint256) {
        return 0;
    }

    function register(address, uint256, uint256, uint256, uint256[8] calldata) external override {
        // no-op for testing
    }
}
