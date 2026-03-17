// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import {RevenueRouter, INewsStaking} from "../src/RevenueRouter.sol";
import {NewsStaking} from "../src/NewsStaking.sol";
import {NewsToken} from "../src/NewsToken.sol";
import {MockUSDC} from "./mock/MockUSDC.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

contract RevenueRouterTest is Test {
    RevenueRouter public router;
    NewsStaking public staking;
    NewsToken public news;
    MockUSDC public usdc;

    address alice = makeAddr("alice");
    address treasury = makeAddr("treasury");
    address x402Worker = makeAddr("x402Worker");

    function setUp() public {
        news = new NewsToken(address(this));
        usdc = new MockUSDC();
        staking = new NewsStaking(IERC20(address(news)), IERC20(address(usdc)));
        router = new RevenueRouter(IERC20(address(usdc)), INewsStaking(address(staking)), treasury);

        // Alice stakes NEWS so depositRevenue doesn't revert
        news.mint(alice, 1000e18);
        vm.prank(alice);
        news.approve(address(staking), type(uint256).max);
        vm.prank(alice);
        staking.stake(500e18);
    }

    // ─── 1. Basic distribution (100% to stakers) ────────────

    function test_distribute_allToStakers() public {
        // Simulate x402 revenue arriving at router
        usdc.mint(address(router), 100e6);

        router.distribute();

        // All USDC should be in staking contract
        assertEq(usdc.balanceOf(address(staking)), 100e6);
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(router.totalDistributed(), 100e6);

        // Alice should have pending rewards
        assertEq(staking.pendingRewards(alice), 100e6);
    }

    // ─── 2. Split distribution ──────────────────────────────

    function test_distribute_withSplit() public {
        router.setStakingBps(8000); // 80% stakers, 20% treasury

        usdc.mint(address(router), 100e6);
        router.distribute();

        assertEq(usdc.balanceOf(address(staking)), 80e6);
        assertEq(usdc.balanceOf(treasury), 20e6);
        assertEq(staking.pendingRewards(alice), 80e6);
    }

    // ─── 3. Nothing to distribute ───────────────────────────

    function test_distribute_emptyReverts() public {
        vm.expectRevert(RevenueRouter.NothingToDistribute.selector);
        router.distribute();
    }

    // ─── 4. Multiple distributions accumulate ───────────────

    function test_multipleDistributions() public {
        usdc.mint(address(router), 50e6);
        router.distribute();

        usdc.mint(address(router), 30e6);
        router.distribute();

        assertEq(router.totalDistributed(), 80e6);
        assertEq(staking.pendingRewards(alice), 80e6);
    }

    // ─── 5. Permissionless — anyone can distribute ──────────

    function test_distribute_permissionless() public {
        usdc.mint(address(router), 10e6);

        vm.prank(makeAddr("random"));
        router.distribute();

        assertEq(usdc.balanceOf(address(staking)), 10e6);
    }

    // ─── 6. Admin: setStakingBps ────────────────────────────

    function test_setStakingBps() public {
        router.setStakingBps(7000);
        assertEq(router.stakingBps(), 7000);
    }

    function test_setStakingBps_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(RevenueRouter.OnlyOwner.selector);
        router.setStakingBps(5000);
    }

    function test_setStakingBps_invalidReverts() public {
        vm.expectRevert(RevenueRouter.InvalidBps.selector);
        router.setStakingBps(10001);
    }

    // ─── 7. Admin: setTreasury ──────────────────────────────

    function test_setTreasury() public {
        address newTreasury = makeAddr("newTreasury");
        router.setTreasury(newTreasury);
        assertEq(router.treasury(), newTreasury);
    }

    // ─── 8. Admin: setOwner ─────────────────────────────────

    function test_setOwner() public {
        address newOwner = makeAddr("newOwner");
        router.setOwner(newOwner);
        assertEq(router.owner(), newOwner);

        // Old owner can no longer admin
        vm.expectRevert(RevenueRouter.OnlyOwner.selector);
        router.setStakingBps(5000);
    }

    // ─── 9. Treasury split with zero treasury address ───────

    function test_distribute_splitWithZeroTreasuryReverts() public {
        router.setTreasury(address(0));
        router.setStakingBps(8000); // 20% would go to treasury

        usdc.mint(address(router), 100e6);

        vm.expectRevert(RevenueRouter.ZeroAddress.selector);
        router.distribute();
    }

    // ─── 10. Full lifecycle ─────────────────────────────────

    function test_fullLifecycle() public {
        // Phase 1: 100% to stakers
        usdc.mint(address(router), 50e6);
        router.distribute();
        assertEq(staking.pendingRewards(alice), 50e6);

        // Phase 2: Owner introduces 10% treasury cut
        router.setStakingBps(9000);

        usdc.mint(address(router), 100e6);
        router.distribute();

        // Alice gets 50 + 90 = 140 USDC in staking rewards
        assertEq(staking.pendingRewards(alice), 140e6);
        // Treasury gets 10 USDC
        assertEq(usdc.balanceOf(treasury), 10e6);
        // Total distributed: 150 USDC
        assertEq(router.totalDistributed(), 150e6);
    }
}
