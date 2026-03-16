// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @dev Minimal interface for World ID's group-based proof verification.
/// Full source: https://github.com/worldcoin/world-id-contracts
interface IWorldIDGroups {
    function verifyProof(
        uint256 root,
        uint256 groupId,
        uint256 signalHash,
        uint256 nullifierHash,
        uint256 externalNullifierHash,
        uint256[8] calldata proof
    ) external;
}
