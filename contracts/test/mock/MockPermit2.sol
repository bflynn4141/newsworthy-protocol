// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {ISignatureTransfer} from "../../src/interfaces/ISignatureTransfer.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";

/// @dev Mock Permit2 for testing. Ignores signatures, just does the transferFrom.
contract MockPermit2 is ISignatureTransfer {
    bool public shouldRevert;

    function setShouldRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    function permitTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata /* signature */
    ) external override {
        if (shouldRevert) revert("invalid permit");
        IERC20(permit.permitted.token).transferFrom(owner, transferDetails.to, transferDetails.requestedAmount);
    }
}
