// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import {NewsStaking} from "../src/NewsStaking.sol";
import {NewsToken} from "../src/NewsToken.sol";
import {MockUSDC} from "./mock/MockUSDC.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

contract NewsStakingTest is Test {
    NewsStaking public staking;
    NewsToken public news;
    MockUSDC public usdc;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address x402Worker = makeAddr("x402Worker");

    function setUp() public {
        news = new NewsToken(address(this)); // test contract is minter
        usdc = new MockUSDC();

        staking = new NewsStaking(IERC20(address(news)), IERC20(address(usdc)));

        // Mint $NEWS to stakers
        news.mint(alice, 1000e18);
        news.mint(bob, 1000e18);

        // Approve staking contract
        vm.prank(alice);
        news.approve(address(staking), type(uint256).max);
        vm.prank(bob);
        news.approve(address(staking), type(uint256).max);

        // Fund x402 worker with USDC and approve staking
        usdc.mint(x402Worker, 10_000e6);
        vm.prank(x402Worker);
        usdc.approve(address(staking), type(uint256).max);
    }

    // ─── 1. Stake ─────────────────────────────────────────

    function test_stake() public {
        vm.prank(alice);
        staking.stake(100e18);

        assertEq(staking.staked(alice), 100e18);
        assertEq(staking.totalStaked(), 100e18);
        assertEq(news.balanceOf(alice), 900e18);
        assertEq(news.balanceOf(address(staking)), 100e18);
    }

    function test_stake_zeroReverts() public {
        vm.prank(alice);
        vm.expectRevert(NewsStaking.ZeroAmount.selector);
        staking.stake(0);
    }

    // ─── 2. Unstake ───────────────────────────────────────

    function test_unstake() public {
        vm.prank(alice);
        staking.stake(100e18);

        vm.prank(alice);
        staking.unstake(40e18);

        assertEq(staking.staked(alice), 60e18);
        assertEq(staking.totalStaked(), 60e18);
        assertEq(news.balanceOf(alice), 940e18);
    }

    function test_unstake_insufficientReverts() public {
        vm.prank(alice);
        staking.stake(100e18);

        vm.prank(alice);
        vm.expectRevert(NewsStaking.InsufficientStake.selector);
        staking.unstake(101e18);
    }

    // ─── 3. Deposit revenue ───────────────────────────────

    function test_depositRevenue() public {
        vm.prank(alice);
        staking.stake(100e18);

        vm.prank(x402Worker);
        staking.depositRevenue(10e6); // 10 USDC

        assertEq(usdc.balanceOf(address(staking)), 10e6);
        assertEq(staking.pendingRewards(alice), 10e6);
    }

    function test_depositRevenue_noStakersReverts() public {
        vm.prank(x402Worker);
        vm.expectRevert(NewsStaking.ZeroAmount.selector);
        staking.depositRevenue(10e6);
    }

    // ─── 4. Pro-rata distribution ─────────────────────────

    function test_proRata_equalStakes() public {
        vm.prank(alice);
        staking.stake(100e18);
        vm.prank(bob);
        staking.stake(100e18);

        vm.prank(x402Worker);
        staking.depositRevenue(10e6); // 10 USDC split 50/50

        assertEq(staking.pendingRewards(alice), 5e6);
        assertEq(staking.pendingRewards(bob), 5e6);
    }

    function test_proRata_unequalStakes() public {
        vm.prank(alice);
        staking.stake(300e18); // 75%
        vm.prank(bob);
        staking.stake(100e18); // 25%

        vm.prank(x402Worker);
        staking.depositRevenue(100e6); // 100 USDC

        assertEq(staking.pendingRewards(alice), 75e6);
        assertEq(staking.pendingRewards(bob), 25e6);
    }

    // ─── 5. Claim rewards ─────────────────────────────────

    function test_claimRewards() public {
        vm.prank(alice);
        staking.stake(100e18);

        vm.prank(x402Worker);
        staking.depositRevenue(10e6);

        uint256 balBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        staking.claimRewards();

        assertEq(usdc.balanceOf(alice), balBefore + 10e6);
        assertEq(staking.pendingRewards(alice), 0);
    }

    function test_claimRewards_nothingReverts() public {
        vm.prank(alice);
        vm.expectRevert(NewsStaking.NothingToClaim.selector);
        staking.claimRewards();
    }

    // ─── 6. Multiple revenue deposits accumulate ──────────

    function test_multipleDeposits() public {
        vm.prank(alice);
        staking.stake(100e18);

        vm.prank(x402Worker);
        staking.depositRevenue(5e6);
        vm.prank(x402Worker);
        staking.depositRevenue(15e6);

        assertEq(staking.pendingRewards(alice), 20e6);
    }

    // ─── 7. Stake after revenue — no retroactive rewards ──

    function test_stakeAfterRevenue_noRetroactive() public {
        vm.prank(alice);
        staking.stake(100e18);

        vm.prank(x402Worker);
        staking.depositRevenue(10e6);

        // Bob stakes AFTER revenue — should get nothing from prior deposit
        vm.prank(bob);
        staking.stake(100e18);

        assertEq(staking.pendingRewards(alice), 10e6);
        assertEq(staking.pendingRewards(bob), 0);

        // New revenue splits 50/50
        vm.prank(x402Worker);
        staking.depositRevenue(10e6);

        assertEq(staking.pendingRewards(alice), 15e6);
        assertEq(staking.pendingRewards(bob), 5e6);
    }

    // ─── 8. Unstake preserves unclaimed rewards ───────────

    function test_unstake_preservesRewards() public {
        vm.prank(alice);
        staking.stake(100e18);

        vm.prank(x402Worker);
        staking.depositRevenue(10e6);

        // Unstake all — rewards should still be claimable
        vm.prank(alice);
        staking.unstake(100e18);

        assertEq(staking.pendingRewards(alice), 10e6);

        vm.prank(alice);
        staking.claimRewards();
        assertEq(usdc.balanceOf(alice), 10e6);
    }

    // ─── 9. Full lifecycle ────────────────────────────────

    function test_fullLifecycle() public {
        // Alice stakes 200, Bob stakes 100
        vm.prank(alice);
        staking.stake(200e18);
        vm.prank(bob);
        staking.stake(100e18);

        // Revenue 1: 30 USDC → Alice 20, Bob 10
        vm.prank(x402Worker);
        staking.depositRevenue(30e6);

        // Alice claims
        vm.prank(alice);
        staking.claimRewards();
        assertEq(usdc.balanceOf(alice), 20e6);

        // Alice unstakes half
        vm.prank(alice);
        staking.unstake(100e18);

        // Revenue 2: 20 USDC → Alice 10 (100/200), Bob 10 (100/200)
        vm.prank(x402Worker);
        staking.depositRevenue(20e6);

        // Bob claims everything (10 from rev1 + 10 from rev2)
        vm.prank(bob);
        staking.claimRewards();
        assertEq(usdc.balanceOf(bob), 20e6);

        // Alice claims rev2 portion
        vm.prank(alice);
        staking.claimRewards();
        assertEq(usdc.balanceOf(alice), 30e6); // 20 + 10
    }
}
