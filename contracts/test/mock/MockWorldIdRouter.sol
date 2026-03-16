// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IWorldIDGroups} from "../../src/interfaces/IWorldIDGroups.sol";

/// @dev Mock World ID router for testing. By default, all proofs pass.
///      Set shouldRevert = true to simulate invalid proofs.
contract MockWorldIdRouter is IWorldIDGroups {
    bool public shouldRevert;

    function setShouldRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    function verifyProof(
        uint256,
        uint256,
        uint256,
        uint256,
        uint256,
        uint256[8] calldata
    ) external view override {
        if (shouldRevert) revert("invalid proof");
    }
}
