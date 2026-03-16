// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import {FeedRegistry} from "../src/FeedRegistry.sol";
import {NewsToken} from "../src/NewsToken.sol";
import {MockAgentBook} from "./mock/MockAgentBook.sol";
import {MockUSDC} from "./mock/MockUSDC.sol";
import {IAgentBook} from "../src/interfaces/IAgentBook.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {INewsToken} from "../src/interfaces/INewsToken.sol";

contract FeedRegistryTest is Test {
    FeedRegistry public registry;
    MockAgentBook public agentBook;
    MockUSDC public usdc;
    NewsToken public news;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");
    address unregistered = makeAddr("unregistered");

    uint256 constant BOND = 1e6; // 1 USDC (6 decimals)
    uint256 constant CHALLENGE_PERIOD = 1 hours;
    uint256 constant VOTING_PERIOD = 1 hours;
    uint256 constant MIN_VOTES = 3;
    uint256 constant NEWS_PER_ITEM = 100e18; // 100 $NEWS per accepted item
    uint256 constant MAX_DAILY = 3;

    function setUp() public {
        agentBook = new MockAgentBook();
        usdc = new MockUSDC();

        // Deploy NewsToken with this test contract as temporary minter
        news = new NewsToken(address(this));

        registry = new FeedRegistry(
            IAgentBook(address(agentBook)),
            IERC20(address(usdc)),
            INewsToken(address(news)),
            BOND,
            CHALLENGE_PERIOD,
            VOTING_PERIOD,
            MIN_VOTES,
            NEWS_PER_ITEM,
            MAX_DAILY
        );

        // Transfer minter role to registry
        news.setMinter(address(registry));

        // Register agents with distinct humanIds
        agentBook.setHumanId(alice, 1);
        agentBook.setHumanId(bob, 2);
        agentBook.setHumanId(carol, 3);
        agentBook.setHumanId(dave, 4);

        // Mint USDC and approve registry for all test accounts
        address[4] memory users = [alice, bob, carol, dave];
        for (uint256 i = 0; i < users.length; i++) {
            usdc.mint(users[i], 100e6); // 100 USDC each
            vm.prank(users[i]);
            usdc.approve(address(registry), type(uint256).max);
        }
    }

    // ─── Helpers ──────────────────────────────────────────

    function _submitItem(address submitter, string memory url) internal returns (uint256) {
        vm.prank(submitter);
        registry.submitItem(url, "QmTest");
        return registry.nextItemId() - 1;
    }

    function _challengeItem(address challenger, uint256 itemId) internal {
        vm.prank(challenger);
        registry.challengeItem(itemId);
    }

    function _vote(address voter, uint256 itemId, bool support) internal {
        vm.prank(voter);
        registry.voteOnChallenge(itemId, support);
    }

    // ─── 1. Submit: registered ────────────────────────────

    function test_submitItem_registered() public {
        uint256 balBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit FeedRegistry.ItemSubmitted(0, alice, "https://x.com/alice/status/1000000000000000001");
        registry.submitItem("https://x.com/alice/status/1000000000000000001", "QmHash1");

        (address submitter,,,, uint256 submittedAt, FeedRegistry.ItemStatus status) =
            registry.items(0);

        assertEq(submitter, alice);
        assertEq(submittedAt, block.timestamp);
        assertEq(uint8(status), uint8(FeedRegistry.ItemStatus.Pending));
        assertEq(registry.nextItemId(), 1);
        // Bond pulled from alice
        assertEq(usdc.balanceOf(alice), balBefore - BOND);
        // Bond held by registry
        assertEq(usdc.balanceOf(address(registry)), BOND);
    }

    // ─── 2. Submit: unregistered ──────────────────────────

    function test_submitItem_unregistered() public {
        vm.prank(unregistered);
        vm.expectRevert(FeedRegistry.NotRegistered.selector);
        registry.submitItem("https://x.com/user/status/1000000000000000002", "QmHash2");
    }

    // ─── 3. Submit: duplicate URL ─────────────────────────

    function test_submitItem_duplicateUrl() public {
        _submitItem(alice, "https://x.com/user/status/1000000000000000003");

        vm.prank(bob);
        vm.expectRevert(FeedRegistry.DuplicateUrl.selector);
        registry.submitItem("https://x.com/user/status/1000000000000000003", "QmHash");
    }

    // ─── 3b. Submit: invalid URL ────────────────────────────

    function test_submitItem_invalidUrl() public {
        vm.prank(alice);
        vm.expectRevert(FeedRegistry.InvalidUrl.selector);
        registry.submitItem("https://example.com/not-a-tweet", "QmHash");
    }

    function test_submitItem_invalidUrl_noStatus() public {
        vm.prank(alice);
        vm.expectRevert(FeedRegistry.InvalidUrl.selector);
        registry.submitItem("https://x.com/user/profile", "QmHash");
    }

    function test_submitItem_twitterDotCom() public {
        _submitItem(alice, "https://twitter.com/user/status/1000000000000000099");
        assertEq(registry.nextItemId(), 1);
    }

    // ─── 3c. Submit: daily limit ────────────────────────────

    function test_submitItem_dailyLimit() public {
        _submitItem(alice, "https://x.com/user/status/1000000000000000030");
        _submitItem(alice, "https://x.com/user/status/1000000000000000031");
        _submitItem(alice, "https://x.com/user/status/1000000000000000032");

        // 4th submission should fail
        vm.prank(alice);
        vm.expectRevert(FeedRegistry.DailyLimitReached.selector);
        registry.submitItem("https://x.com/user/status/1000000000000000033", "QmHash");
    }

    function test_submitItem_dailyLimit_resetsNextDay() public {
        _submitItem(alice, "https://x.com/user/status/1000000000000000040");
        _submitItem(alice, "https://x.com/user/status/1000000000000000041");
        _submitItem(alice, "https://x.com/user/status/1000000000000000042");

        // Warp to next day
        vm.warp(block.timestamp + 1 days);

        // Should succeed — new day
        _submitItem(alice, "https://x.com/user/status/1000000000000000043");
        assertEq(registry.nextItemId(), 4);
    }

    function test_submitItem_dailyLimit_perHuman() public {
        // Alice uses up her limit
        _submitItem(alice, "https://x.com/user/status/1000000000000000050");
        _submitItem(alice, "https://x.com/user/status/1000000000000000051");
        _submitItem(alice, "https://x.com/user/status/1000000000000000052");

        // Bob should still be able to submit
        _submitItem(bob, "https://x.com/user/status/1000000000000000053");
        assertEq(registry.nextItemId(), 4);
    }

    // ─── 4. Challenge: success ────────────────────────────

    function test_challengeItem() public {
        uint256 itemId = _submitItem(alice, "https://x.com/user/status/1000000000000000004");

        uint256 bobBefore = usdc.balanceOf(bob);

        vm.prank(bob);
        vm.expectEmit(true, true, false, true);
        emit FeedRegistry.ItemChallenged(itemId, bob);
        registry.challengeItem(itemId);

        (,,,,, FeedRegistry.ItemStatus status) = registry.items(itemId);
        assertEq(uint8(status), uint8(FeedRegistry.ItemStatus.Challenged));
        // Bob's bond pulled
        assertEq(usdc.balanceOf(bob), bobBefore - BOND);
        // Registry holds both bonds
        assertEq(usdc.balanceOf(address(registry)), 2 * BOND);
    }

    // ─── 5. Challenge: self-challenge ─────────────────────

    function test_challengeItem_selfChallenge() public {
        uint256 itemId = _submitItem(alice, "https://x.com/user/status/1000000000000000005");

        address aliceAlt = makeAddr("aliceAlt");
        agentBook.setHumanId(aliceAlt, 1);
        usdc.mint(aliceAlt, 100e6);
        vm.prank(aliceAlt);
        usdc.approve(address(registry), type(uint256).max);

        vm.prank(aliceAlt);
        vm.expectRevert(FeedRegistry.SelfChallenge.selector);
        registry.challengeItem(itemId);
    }

    // ─── 6. Vote: success ─────────────────────────────────

    function test_voteOnChallenge() public {
        uint256 itemId = _submitItem(alice, "https://x.com/user/status/1000000000000000006");
        _challengeItem(bob, itemId);

        vm.prank(carol);
        vm.expectEmit(true, true, false, true);
        emit FeedRegistry.VoteCast(itemId, 3, true);
        registry.voteOnChallenge(itemId, true);

        (,,, uint256 votesFor,) = registry.challenges(itemId);
        assertEq(votesFor, 1);
    }

    // ─── 7. Vote: double vote (same human, different wallets) ──

    function test_voteOnChallenge_doubleVote() public {
        uint256 itemId = _submitItem(alice, "https://x.com/user/status/1000000000000000007");
        _challengeItem(bob, itemId);

        _vote(carol, itemId, true);

        address carolAlt = makeAddr("carolAlt");
        agentBook.setHumanId(carolAlt, 3);

        vm.prank(carolAlt);
        vm.expectRevert(FeedRegistry.AlreadyVoted.selector);
        registry.voteOnChallenge(itemId, false);
    }

    // ─── 8. Resolve: keep wins ────────────────────────────

    function test_resolveChallenge_keepWins() public {
        uint256 itemId = _submitItem(alice, "https://x.com/user/status/1000000000000000008");
        _challengeItem(bob, itemId);

        _vote(carol, itemId, true);
        _vote(dave, itemId, true);
        _vote(alice, itemId, true);

        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        registry.resolveChallenge(itemId);

        (,,,,, FeedRegistry.ItemStatus status) = registry.items(itemId);
        assertEq(uint8(status), uint8(FeedRegistry.ItemStatus.Accepted));

        uint256 totalPool = 2 * BOND;
        uint256 voterPool = (totalPool * 3000) / 10_000;
        uint256 winnerPayout = totalPool - voterPool;
        uint256 perVoter = voterPool / 3;

        assertEq(registry.pendingWithdrawals(alice), winnerPayout + perVoter);
        assertEq(registry.pendingWithdrawals(carol), perVoter);
        assertEq(registry.pendingWithdrawals(dave), perVoter);
        assertEq(registry.pendingWithdrawals(bob), 0);

        // Submitter earned $NEWS
        assertEq(news.balanceOf(alice), NEWS_PER_ITEM);
    }

    // ─── 9. Resolve: remove wins ──────────────────────────

    function test_resolveChallenge_removeWins() public {
        uint256 itemId = _submitItem(alice, "https://x.com/user/status/1000000000000000009");
        _challengeItem(bob, itemId);

        _vote(carol, itemId, false);
        _vote(dave, itemId, false);
        _vote(bob, itemId, false);

        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        registry.resolveChallenge(itemId);

        (,,,,, FeedRegistry.ItemStatus status) = registry.items(itemId);
        assertEq(uint8(status), uint8(FeedRegistry.ItemStatus.Rejected));

        uint256 totalPool = 2 * BOND;
        uint256 voterPool = (totalPool * 3000) / 10_000;
        uint256 winnerPayout = totalPool - voterPool;
        uint256 perVoter = voterPool / 3;

        assertEq(registry.pendingWithdrawals(bob), winnerPayout + perVoter);
        assertEq(registry.pendingWithdrawals(carol), perVoter);
        assertEq(registry.pendingWithdrawals(dave), perVoter);
        assertEq(registry.pendingWithdrawals(alice), 0);

        // Rejected — no $NEWS minted
        assertEq(news.balanceOf(alice), 0);
    }

    // ─── 10. Resolve: no quorum ───────────────────────────

    function test_resolveNoQuorum() public {
        uint256 itemId = _submitItem(alice, "https://x.com/user/status/1000000000000000010");
        _challengeItem(bob, itemId);

        _vote(carol, itemId, true);
        _vote(dave, itemId, false);

        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        registry.resolveNoQuorum(itemId);

        (,,,,, FeedRegistry.ItemStatus status) = registry.items(itemId);
        assertEq(uint8(status), uint8(FeedRegistry.ItemStatus.Accepted));

        assertEq(registry.pendingWithdrawals(alice), BOND);
        assertEq(registry.pendingWithdrawals(bob), BOND);

        // Accepted via no-quorum — submitter still earns $NEWS
        assertEq(news.balanceOf(alice), NEWS_PER_ITEM);
    }

    // ─── 11. Accept: unchallenged item ────────────────────

    function test_acceptItem() public {
        uint256 itemId = _submitItem(alice, "https://x.com/user/status/1000000000000000011");

        vm.warp(block.timestamp + CHALLENGE_PERIOD + 1);

        vm.expectEmit(true, false, false, true);
        emit FeedRegistry.ItemAccepted(itemId);
        registry.acceptItem(itemId);

        (,,,,, FeedRegistry.ItemStatus status) = registry.items(itemId);
        assertEq(uint8(status), uint8(FeedRegistry.ItemStatus.Accepted));

        assertEq(registry.pendingWithdrawals(alice), BOND);

        // Submitter earned $NEWS
        assertEq(news.balanceOf(alice), NEWS_PER_ITEM);
    }

    // ─── 12. Withdraw: claim USDC rewards ─────────────────

    function test_withdraw() public {
        uint256 itemId = _submitItem(alice, "https://x.com/user/status/1000000000000000012");

        vm.warp(block.timestamp + CHALLENGE_PERIOD + 1);
        registry.acceptItem(itemId);

        uint256 balanceBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit FeedRegistry.Withdrawal(alice, BOND);
        registry.withdraw();

        assertEq(usdc.balanceOf(alice), balanceBefore + BOND);
        assertEq(registry.pendingWithdrawals(alice), 0);
    }

    // ─── 13. Challenge: period expired ────────────────────

    function test_challengePeriod_expired() public {
        uint256 itemId = _submitItem(alice, "https://x.com/user/status/1000000000000000013");

        vm.warp(block.timestamp + CHALLENGE_PERIOD + 1);

        vm.prank(bob);
        vm.expectRevert(FeedRegistry.ChallengePeriodExpired.selector);
        registry.challengeItem(itemId);
    }

    // ─── 14. $NEWS: multiple acceptances accumulate ───────

    function test_newsAccumulates() public {
        uint256 id1 = _submitItem(alice, "https://x.com/user/status/1000000000000000014");
        uint256 id2 = _submitItem(alice, "https://x.com/user/status/1000000000000000015");

        vm.warp(block.timestamp + CHALLENGE_PERIOD + 1);

        registry.acceptItem(id1);
        registry.acceptItem(id2);

        assertEq(news.balanceOf(alice), NEWS_PER_ITEM * 2);
    }
}
