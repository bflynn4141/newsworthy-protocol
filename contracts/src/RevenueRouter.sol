// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IERC20} from "./interfaces/IERC20.sol";

interface INewsStaking {
    function depositRevenue(uint256 amount) external;
}

/// @title Revenue Router
/// @notice Receives x402 API revenue (USDC) and routes it to NEWS stakers.
///         The x402 payment endpoint sends USDC here; a keeper calls `distribute()`
///         to forward the accumulated balance to the NewsStaking contract.
/// @dev    Starts at 100% to stakers. Owner can adjust `stakingBps` to split
///         revenue between stakers and a protocol treasury in the future.
contract RevenueRouter {
    ///////////////////////////////////////////////////////////////////////////
    ///                                ERRORS                               ///
    ///////////////////////////////////////////////////////////////////////////

    error OnlyOwner();
    error ZeroAddress();
    error InvalidBps();
    error NothingToDistribute();
    error TransferFailed();

    ///////////////////////////////////////////////////////////////////////////
    ///                                EVENTS                               ///
    ///////////////////////////////////////////////////////////////////////////

    event Distributed(uint256 toStaking, uint256 toTreasury);
    event StakingBpsUpdated(uint256 newBps);
    event TreasuryUpdated(address newTreasury);
    event OwnerUpdated(address newOwner);

    ///////////////////////////////////////////////////////////////////////////
    ///                                STATE                                ///
    ///////////////////////////////////////////////////////////////////////////

    IERC20 public immutable usdc;
    INewsStaking public immutable staking;

    address public owner;
    address public treasury;        // receives (10000 - stakingBps) share
    uint256 public stakingBps;      // basis points to stakers (10000 = 100%)

    uint256 public totalDistributed; // lifetime USDC routed through

    ///////////////////////////////////////////////////////////////////////////
    ///                              CONSTRUCTOR                            ///
    ///////////////////////////////////////////////////////////////////////////

    /// @param _usdc     USDC token address.
    /// @param _staking  NewsStaking contract address.
    /// @param _treasury Address that receives the non-staking share (can be address(0) while stakingBps == 10000).
    constructor(IERC20 _usdc, INewsStaking _staking, address _treasury) {
        if (address(_usdc) == address(0) || address(_staking) == address(0)) revert ZeroAddress();

        usdc = _usdc;
        staking = _staking;
        treasury = _treasury;
        stakingBps = 10000; // 100% to stakers
        owner = msg.sender;
    }

    ///////////////////////////////////////////////////////////////////////////
    ///                              DISTRIBUTE                             ///
    ///////////////////////////////////////////////////////////////////////////

    /// @notice Forward accumulated USDC to staking contract (and treasury if split).
    ///         Permissionless — anyone can call this.
    function distribute() external {
        uint256 balance = usdc.balanceOf(address(this));
        if (balance == 0) revert NothingToDistribute();

        uint256 toStaking = (balance * stakingBps) / 10000;
        uint256 toTreasury = balance - toStaking;

        totalDistributed += balance;

        // Send to staking
        if (toStaking > 0) {
            if (!usdc.approve(address(staking), toStaking)) revert TransferFailed();
            staking.depositRevenue(toStaking);
        }

        // Send remainder to treasury
        if (toTreasury > 0) {
            if (treasury == address(0)) revert ZeroAddress();
            if (!usdc.transfer(treasury, toTreasury)) revert TransferFailed();
        }

        emit Distributed(toStaking, toTreasury);
    }

    ///////////////////////////////////////////////////////////////////////////
    ///                              ADMIN                                  ///
    ///////////////////////////////////////////////////////////////////////////

    /// @notice Update the staking/treasury split. Max 10000 (100% to stakers).
    function setStakingBps(uint256 _bps) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (_bps > 10000) revert InvalidBps();
        stakingBps = _bps;
        emit StakingBpsUpdated(_bps);
    }

    /// @notice Update the treasury address.
    function setTreasury(address _treasury) external {
        if (msg.sender != owner) revert OnlyOwner();
        treasury = _treasury;
        emit TreasuryUpdated(_treasury);
    }

    /// @notice Transfer ownership.
    function setOwner(address _owner) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
        emit OwnerUpdated(_owner);
    }
}
