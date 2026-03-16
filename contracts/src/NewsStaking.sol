// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IERC20} from "./interfaces/IERC20.sol";

/// @title NEWS Staking
/// @notice Stake $NEWS to earn pro-rata USDC revenue from x402 API queries.
///         Uses the Synthetix RewardPerToken accumulator pattern for O(1) distributions.
/// @dev Revenue flows in via `depositRevenue()` — called by the x402 payment endpoint.
///      Anyone can call it (permissionless deposits), but typically it's the x402 worker.
contract NewsStaking {
    ///////////////////////////////////////////////////////////////////////////
    ///                                ERRORS                               ///
    ///////////////////////////////////////////////////////////////////////////

    error ZeroAmount();
    error InsufficientStake();
    error NothingToClaim();
    error TransferFailed();

    ///////////////////////////////////////////////////////////////////////////
    ///                                EVENTS                               ///
    ///////////////////////////////////////////////////////////////////////////

    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event RevenueDeposited(address indexed depositor, uint256 amount);
    event RewardClaimed(address indexed user, uint256 amount);

    ///////////////////////////////////////////////////////////////////////////
    ///                                STATE                                ///
    ///////////////////////////////////////////////////////////////////////////

    IERC20 public immutable newsToken;   // $NEWS — the staked token
    IERC20 public immutable rewardToken; // USDC — the reward token

    uint256 public totalStaked;
    mapping(address => uint256) public staked;

    // Accumulator: USDC earned per 1e18 staked $NEWS (scaled by 1e18 for precision)
    uint256 public rewardPerTokenStored;
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards; // unclaimed USDC

    ///////////////////////////////////////////////////////////////////////////
    ///                              CONSTRUCTOR                            ///
    ///////////////////////////////////////////////////////////////////////////

    constructor(IERC20 _newsToken, IERC20 _rewardToken) {
        newsToken = _newsToken;
        rewardToken = _rewardToken;
    }

    ///////////////////////////////////////////////////////////////////////////
    ///                              STAKING                                ///
    ///////////////////////////////////////////////////////////////////////////

    /// @notice Stake $NEWS tokens to start earning USDC revenue.
    /// @param amount Amount of $NEWS to stake (must have approved this contract).
    function stake(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        _updateReward(msg.sender);

        if (!newsToken.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();

        staked[msg.sender] += amount;
        totalStaked += amount;

        emit Staked(msg.sender, amount);
    }

    /// @notice Unstake $NEWS tokens. Unclaimed rewards are preserved.
    /// @param amount Amount of $NEWS to withdraw.
    function unstake(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (staked[msg.sender] < amount) revert InsufficientStake();
        _updateReward(msg.sender);

        staked[msg.sender] -= amount;
        totalStaked -= amount;

        if (!newsToken.transfer(msg.sender, amount)) revert TransferFailed();

        emit Unstaked(msg.sender, amount);
    }

    ///////////////////////////////////////////////////////////////////////////
    ///                              REVENUE                                ///
    ///////////////////////////////////////////////////////////////////////////

    /// @notice Deposit USDC revenue to be distributed to stakers.
    ///         Caller must have approved `amount` of rewardToken to this contract.
    ///         Permissionless — anyone can deposit (typically the x402 payment worker).
    /// @param amount Amount of USDC to distribute.
    function depositRevenue(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (totalStaked == 0) revert ZeroAmount(); // no stakers to receive

        if (!rewardToken.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();

        // Scale by 1e18 for precision before dividing by totalStaked
        rewardPerTokenStored += (amount * 1e18) / totalStaked;

        emit RevenueDeposited(msg.sender, amount);
    }

    ///////////////////////////////////////////////////////////////////////////
    ///                              CLAIMS                                 ///
    ///////////////////////////////////////////////////////////////////////////

    /// @notice Claim accumulated USDC rewards.
    function claimRewards() external {
        _updateReward(msg.sender);

        uint256 reward = rewards[msg.sender];
        if (reward == 0) revert NothingToClaim();

        rewards[msg.sender] = 0;

        if (!rewardToken.transfer(msg.sender, reward)) revert TransferFailed();

        emit RewardClaimed(msg.sender, reward);
    }

    /// @notice View pending USDC rewards for an account.
    function pendingRewards(address account) external view returns (uint256) {
        uint256 perToken = rewardPerTokenStored;
        uint256 earned = (staked[account] * (perToken - userRewardPerTokenPaid[account])) / 1e18;
        return rewards[account] + earned;
    }

    ///////////////////////////////////////////////////////////////////////////
    ///                              INTERNAL                               ///
    ///////////////////////////////////////////////////////////////////////////

    /// @dev Snapshot the user's earned rewards before any stake change.
    function _updateReward(address account) internal {
        uint256 perToken = rewardPerTokenStored;
        uint256 earned = (staked[account] * (perToken - userRewardPerTokenPaid[account])) / 1e18;
        rewards[account] += earned;
        userRewardPerTokenPaid[account] = perToken;
    }
}
