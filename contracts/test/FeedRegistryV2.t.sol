// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import {FeedRegistryV2} from "../src/FeedRegistryV2.sol";
import {MockAgentBook} from "./mock/MockAgentBook.sol";
import {MockUSDC} from "./mock/MockUSDC.sol";
import {MockWorldIdRouter} from "./mock/MockWorldIdRouter.sol";
import {IAgentBook} from "../src/interfaces/IAgentBook.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {IWorldIDGroups} from "../src/interfaces/IWorldIDGroups.sol";
import {ERC1967Proxy} from "@openzeppelin-contracts-5.0.2/proxy/ERC1967/ERC1967Proxy.sol";

contract FeedRegistryV2Test is Test {
    FeedRegistryV2 public registry;
    FeedRegistryV2 public implementation;
    MockAgentBook public agentBook;
    MockUSDC public usdc;
    MockWorldIdRouter public mockWorldIdRouter;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");
    address eve = makeAddr("eve");
    address frank = makeAddr("frank"); // not in AgentBook, uses voteWithProof
    address unregistered = makeAddr("unregistered");

    uint256 constant WORLD_ID_GROUP = 1;
    uint256 constant EXT_NULLIFIER = 12345;

    uint256 constant BOND = 1e6;            // 1 USDC
    uint256 constant VOTE_COST = 50_000;    // 0.05 USDC
    uint256 constant VOTING_PERIOD = 1 hours;
    uint256 constant MIN_VOTES = 3;
    uint256 constant NEWS_PER_ITEM = 100e18;
    uint256 constant MAX_DAILY = 3;

    function setUp() public {
        agentBook = new MockAgentBook();
        usdc = new MockUSDC();
        mockWorldIdRouter = new MockWorldIdRouter();

        implementation = new FeedRegistryV2();

        bytes memory initData = abi.encodeCall(
            FeedRegistryV2.initialize,
            (
                IAgentBook(address(agentBook)),
                IERC20(address(usdc)),
                address(0), // deprecated newsToken slot
                BOND, VOTE_COST, VOTING_PERIOD, MIN_VOTES, NEWS_PER_ITEM, MAX_DAILY
            )
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), initData);
        registry = FeedRegistryV2(address(proxy));

        // Initialize V2.2 — World ID direct verification
        registry.initializeV2_2(IWorldIDGroups(address(mockWorldIdRouter)), WORLD_ID_GROUP, EXT_NULLIFIER);

        agentBook.setHumanId(alice, 1);
        agentBook.setHumanId(bob, 2);
        agentBook.setHumanId(carol, 3);
        agentBook.setHumanId(dave, 4);
        agentBook.setHumanId(eve, 5);

        address[6] memory users = [alice, bob, carol, dave, eve, frank];
        for (uint256 i = 0; i < users.length; i++) {
            usdc.mint(users[i], 100e6);
            vm.prank(users[i]);
            usdc.approve(address(registry), type(uint256).max);
        }
    }

    // ─── Helpers ──────────────────────────────────────────

    function _submit(address submitter, string memory url) internal returns (uint256) {
        vm.prank(submitter);
        registry.submitItem(url, "QmTest");
        return registry.nextItemId() - 1;
    }

    function _vote(address voter, uint256 itemId, bool support) internal {
        vm.prank(voter);
        registry.vote(itemId, support);
    }

    function _claim(address voter, uint256 itemId) internal {
        vm.prank(voter);
        registry.claim(itemId);
    }

    // ═══════════════════════════════════════════════════════
    //                    INITIALIZATION
    // ═══════════════════════════════════════════════════════

    function test_initialize_paramsSet() public view {
        assertEq(registry.owner(), address(this));
        assertEq(address(registry.agentBook()), address(agentBook));
        assertEq(address(registry.bondToken()), address(usdc));
        assertEq(registry.bondAmount(), BOND);
        assertEq(registry.voteCost(), VOTE_COST);
        assertEq(registry.votingPeriod(), VOTING_PERIOD);
        assertEq(registry.minVotes(), MIN_VOTES);
        assertEq(registry.maxDailySubmissions(), MAX_DAILY);
    }

    function test_initialize_cannotReinitialize() public {
        vm.expectRevert();
        registry.initialize(
            IAgentBook(address(agentBook)), IERC20(address(usdc)), address(0),
            BOND, VOTE_COST, VOTING_PERIOD, MIN_VOTES, NEWS_PER_ITEM, MAX_DAILY
        );
    }

    function test_initialize_implementationLocked() public {
        vm.expectRevert();
        implementation.initialize(
            IAgentBook(address(agentBook)), IERC20(address(usdc)), address(0),
            BOND, VOTE_COST, VOTING_PERIOD, MIN_VOTES, NEWS_PER_ITEM, MAX_DAILY
        );
    }

    function test_initialize_zeroAddressReverts() public {
        FeedRegistryV2 impl2 = new FeedRegistryV2();
        bytes memory badInit = abi.encodeCall(
            FeedRegistryV2.initialize,
            (IAgentBook(address(0)), IERC20(address(usdc)), address(0),
             BOND, VOTE_COST, VOTING_PERIOD, MIN_VOTES, NEWS_PER_ITEM, MAX_DAILY)
        );
        vm.expectRevert();
        new ERC1967Proxy(address(impl2), badInit);

        FeedRegistryV2 impl3 = new FeedRegistryV2();
        badInit = abi.encodeCall(
            FeedRegistryV2.initialize,
            (IAgentBook(address(agentBook)), IERC20(address(0)), address(0),
             BOND, VOTE_COST, VOTING_PERIOD, MIN_VOTES, NEWS_PER_ITEM, MAX_DAILY)
        );
        vm.expectRevert();
        new ERC1967Proxy(address(impl3), badInit);
    }

    // ═══════════════════════════════════════════════════════
    //                      SUBMISSION
    // ═══════════════════════════════════════════════════════

    function test_submit_happyPath() public {
        uint256 balBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit FeedRegistryV2.ItemSubmitted(0, alice, "https://x.com/alice/status/1000000000000000001");
        registry.submitItem("https://x.com/alice/status/1000000000000000001", "QmHash1");

        (address submitter, uint256 humanId,,,, uint256 voteCostSnap, uint256 submittedAt, FeedRegistryV2.ItemStatus status) =
            registry.items(0);

        assertEq(submitter, alice);
        assertEq(humanId, 1);
        assertEq(voteCostSnap, VOTE_COST);
        assertEq(submittedAt, block.timestamp);
        assertEq(uint8(status), uint8(FeedRegistryV2.ItemStatus.Voting));
        assertEq(registry.nextItemId(), 1);
        assertEq(usdc.balanceOf(alice), balBefore - BOND);
        assertEq(usdc.balanceOf(address(registry)), BOND);
    }

    function test_submit_unregistered() public {
        vm.prank(unregistered);
        vm.expectRevert(FeedRegistryV2.NotRegistered.selector);
        registry.submitItem("https://x.com/user/status/1000000000000000002", "QmHash");
    }

    function test_submit_duplicateUrl() public {
        _submit(alice, "https://x.com/user/status/1000000000000000003");
        vm.prank(bob);
        vm.expectRevert(FeedRegistryV2.DuplicateUrl.selector);
        registry.submitItem("https://x.com/user/status/1000000000000000003", "QmHash");
    }

    function test_submit_invalidUrl() public {
        vm.prank(alice);
        vm.expectRevert(FeedRegistryV2.InvalidUrl.selector);
        registry.submitItem("https://example.com/not-a-tweet", "QmHash");
    }

    function test_submit_twitterDotCom() public {
        _submit(alice, "https://twitter.com/user/status/1000000000000000099");
        assertEq(registry.nextItemId(), 1);
    }

    function test_submit_dailyLimit() public {
        _submit(alice, "https://x.com/user/status/1000000000000000030");
        _submit(alice, "https://x.com/user/status/1000000000000000031");
        _submit(alice, "https://x.com/user/status/1000000000000000032");

        vm.prank(alice);
        vm.expectRevert(FeedRegistryV2.DailyLimitReached.selector);
        registry.submitItem("https://x.com/user/status/1000000000000000033", "QmHash");
    }

    function test_submit_dailyLimitResetsNextDay() public {
        _submit(alice, "https://x.com/user/status/1000000000000000040");
        _submit(alice, "https://x.com/user/status/1000000000000000041");
        _submit(alice, "https://x.com/user/status/1000000000000000042");
        vm.warp(block.timestamp + 1 days);
        _submit(alice, "https://x.com/user/status/1000000000000000043");
        assertEq(registry.nextItemId(), 4);
    }

    function test_submit_perHumanLimit() public {
        _submit(alice, "https://x.com/user/status/1000000000000000050");
        _submit(alice, "https://x.com/user/status/1000000000000000051");
        _submit(alice, "https://x.com/user/status/1000000000000000052");
        _submit(bob, "https://x.com/user/status/1000000000000000053");
        assertEq(registry.nextItemId(), 4);
    }

    // ═══════════════════════════════════════════════════════
    //                       VOTING
    // ═══════════════════════════════════════════════════════

    function test_vote_keep() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/1000000000000000060");
        uint256 bobBefore = usdc.balanceOf(bob);

        vm.prank(bob);
        vm.expectEmit(true, true, false, true);
        emit FeedRegistryV2.VoteCast(itemId, 2, true);
        registry.vote(itemId, true);

        (uint256 votesFor, uint256 votesAgainst,,) = registry.getVoteSession(itemId);
        assertEq(votesFor, 1);
        assertEq(votesAgainst, 0);
        assertEq(usdc.balanceOf(bob), bobBefore - VOTE_COST);
        assertEq(uint8(registry.voterSide(itemId, bob)), uint8(FeedRegistryV2.VoteSide.Keep));
    }

    function test_vote_remove() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/1000000000000000061");
        _vote(bob, itemId, false);

        (uint256 votesFor, uint256 votesAgainst,,) = registry.getVoteSession(itemId);
        assertEq(votesFor, 0);
        assertEq(votesAgainst, 1);
        assertEq(uint8(registry.voterSide(itemId, bob)), uint8(FeedRegistryV2.VoteSide.Remove));
    }

    function test_vote_selfVoteBlocked() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/1000000000000000062");
        vm.prank(alice);
        vm.expectRevert(FeedRegistryV2.SelfVote.selector);
        registry.vote(itemId, true);
    }

    function test_vote_selfVoteBlocked_altWallet() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/1000000000000000063");

        address aliceAlt = makeAddr("aliceAlt");
        agentBook.setHumanId(aliceAlt, 1);
        usdc.mint(aliceAlt, 100e6);
        vm.prank(aliceAlt);
        usdc.approve(address(registry), type(uint256).max);

        vm.prank(aliceAlt);
        vm.expectRevert(FeedRegistryV2.SelfVote.selector);
        registry.vote(itemId, true);
    }

    function test_vote_doubleVoteBlocked() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/1000000000000000064");
        _vote(bob, itemId, true);

        address bobAlt = makeAddr("bobAlt");
        agentBook.setHumanId(bobAlt, 2);

        vm.prank(bobAlt);
        vm.expectRevert(FeedRegistryV2.AlreadyVoted.selector);
        registry.vote(itemId, false);
    }

    function test_vote_unregistered() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/1000000000000000065");
        vm.prank(unregistered);
        vm.expectRevert(FeedRegistryV2.NotRegistered.selector);
        registry.vote(itemId, true);
    }

    function test_vote_expired() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/1000000000000000066");
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        vm.prank(bob);
        vm.expectRevert(FeedRegistryV2.VotingPeriodExpired.selector);
        registry.vote(itemId, true);
    }

    // ═══════════════════════════════════════════════════════
    //                RESOLUTION — KEEP WINS
    // ═══════════════════════════════════════════════════════

    function test_resolve_keepWins() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/1000000000000000070");
        _vote(bob, itemId, true);   // keep
        _vote(carol, itemId, true); // keep
        _vote(dave, itemId, false); // remove

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        registry.resolve(itemId);

        (,,,,,,, FeedRegistryV2.ItemStatus status) = registry.items(itemId);
        assertEq(uint8(status), uint8(FeedRegistryV2.ItemStatus.Accepted));

        // Submitter gets bond back immediately
        assertEq(registry.pendingWithdrawals(alice), BOND);

        // Check claim amounts via view
        (, , uint256 keepClaim, uint256 removeClaim) = registry.getVoteSession(itemId);
        // Keep voters: refund + split 1 remove stake over 2 keep voters
        assertEq(keepClaim, VOTE_COST + (1 * VOTE_COST) / 2);
        assertEq(removeClaim, 0);

        // Voters must claim
        _claim(bob, itemId);
        _claim(carol, itemId);
        _claim(dave, itemId);

        assertEq(registry.pendingWithdrawals(bob), keepClaim);
        assertEq(registry.pendingWithdrawals(carol), keepClaim);
        assertEq(registry.pendingWithdrawals(dave), 0); // remove voter gets nothing


    }

    function test_resolve_keepWins_unanimous() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/1000000000000000071");
        _vote(bob, itemId, true);
        _vote(carol, itemId, true);
        _vote(dave, itemId, true);

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        registry.resolve(itemId);

        (,,,,,,, FeedRegistryV2.ItemStatus status) = registry.items(itemId);
        assertEq(uint8(status), uint8(FeedRegistryV2.ItemStatus.Accepted));

        assertEq(registry.pendingWithdrawals(alice), BOND);

        // Keep voters: refund only (no losers to split)
        _claim(bob, itemId);
        _claim(carol, itemId);
        _claim(dave, itemId);
        assertEq(registry.pendingWithdrawals(bob), VOTE_COST);
        assertEq(registry.pendingWithdrawals(carol), VOTE_COST);
        assertEq(registry.pendingWithdrawals(dave), VOTE_COST);


    }

    function test_resolve_tied_contestedRefundsAll() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/1000000000000000072");
        _vote(bob, itemId, true);
        _vote(carol, itemId, false);
        _vote(dave, itemId, true);
        _vote(eve, itemId, false);

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        registry.resolve(itemId);

        (,,,,,,, FeedRegistryV2.ItemStatus status) = registry.items(itemId);
        // V2.6: tie is contested — rejected but everyone refunded
        assertEq(uint8(status), uint8(FeedRegistryV2.ItemStatus.Rejected));

        // Submitter gets bond back (contested = refund)
        assertEq(registry.pendingWithdrawals(alice), BOND);

        // All voters get refunded (no winners or losers in contested zone)
        _claim(bob, itemId);
        _claim(dave, itemId);
        _claim(carol, itemId);
        _claim(eve, itemId);
        assertEq(registry.pendingWithdrawals(bob), VOTE_COST);
        assertEq(registry.pendingWithdrawals(dave), VOTE_COST);
        assertEq(registry.pendingWithdrawals(carol), VOTE_COST);
        assertEq(registry.pendingWithdrawals(eve), VOTE_COST);
    }

    function test_resolve_contested_keepMajorityButNotSuper() public {
        // 3 keep vs 2 remove — keep has majority but not 2:1 supermajority
        uint256 itemId = _submit(alice, "https://x.com/user/status/1000000000000000091");
        _vote(bob, itemId, true);   // keep
        _vote(carol, itemId, true); // keep
        _vote(dave, itemId, true);  // keep
        _vote(eve, itemId, false);  // remove

        // Add a 5th voter to get 3-2 ratio
        address greg = makeAddr("greg");
        agentBook.setHumanId(greg, 6);
        usdc.mint(greg, 100e6);
        vm.prank(greg);
        usdc.approve(address(registry), type(uint256).max);
        _vote(greg, itemId, false); // remove — now 3 keep vs 2 remove

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        registry.resolve(itemId);

        (,,,,,,, FeedRegistryV2.ItemStatus status) = registry.items(itemId);
        // 3:2 = 1.5x ratio, below 2:1 supermajority — contested, rejected
        assertEq(uint8(status), uint8(FeedRegistryV2.ItemStatus.Rejected));

        // Bond refunded (contested zone)
        assertEq(registry.pendingWithdrawals(alice), BOND);

        // All voters refunded
        _claim(bob, itemId);
        _claim(carol, itemId);
        _claim(dave, itemId);
        _claim(eve, itemId);
        _claim(greg, itemId);
        assertEq(registry.pendingWithdrawals(bob), VOTE_COST);
        assertEq(registry.pendingWithdrawals(carol), VOTE_COST);
        assertEq(registry.pendingWithdrawals(dave), VOTE_COST);
        assertEq(registry.pendingWithdrawals(eve), VOTE_COST);
        assertEq(registry.pendingWithdrawals(greg), VOTE_COST);
    }

    function test_resolve_strictMajority_keepWins() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/1000000000000000090");
        _vote(bob, itemId, true);   // keep
        _vote(carol, itemId, true); // keep
        _vote(dave, itemId, true);  // keep
        _vote(eve, itemId, false);  // remove

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        registry.resolve(itemId);

        (,,,,,,, FeedRegistryV2.ItemStatus status) = registry.items(itemId);
        // 3 keep vs 1 remove — 3:1 ratio exceeds 2:1 supermajority, Accepted
        assertEq(uint8(status), uint8(FeedRegistryV2.ItemStatus.Accepted));
        assertEq(registry.pendingWithdrawals(alice), BOND);
    }

    // ═══════════════════════════════════════════════════════
    //               RESOLUTION — REMOVE WINS
    // ═══════════════════════════════════════════════════════

    function test_resolve_removeWins() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/1000000000000000073");
        _vote(bob, itemId, false);  // remove
        _vote(carol, itemId, false);// remove
        _vote(dave, itemId, true);  // keep

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        registry.resolve(itemId);

        (,,,,,,, FeedRegistryV2.ItemStatus status) = registry.items(itemId);
        assertEq(uint8(status), uint8(FeedRegistryV2.ItemStatus.Rejected));

        // Submitter loses bond
        assertEq(registry.pendingWithdrawals(alice), 0);

        // Remove voters: refund + split (bond + 1 keep stake)
        uint256 expectedRemove = VOTE_COST + (BOND + 1 * VOTE_COST) / 2;
        _claim(bob, itemId);
        _claim(carol, itemId);
        _claim(dave, itemId);
        assertEq(registry.pendingWithdrawals(bob), expectedRemove);
        assertEq(registry.pendingWithdrawals(carol), expectedRemove);
        assertEq(registry.pendingWithdrawals(dave), 0);


    }

    function test_resolve_removeWins_unanimous() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/1000000000000000074");
        _vote(bob, itemId, false);
        _vote(carol, itemId, false);
        _vote(dave, itemId, false);

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        registry.resolve(itemId);

        uint256 expectedRemove = VOTE_COST + BOND / 3;
        _claim(bob, itemId);
        _claim(carol, itemId);
        _claim(dave, itemId);
        assertEq(registry.pendingWithdrawals(bob), expectedRemove);
        assertEq(registry.pendingWithdrawals(carol), expectedRemove);
        assertEq(registry.pendingWithdrawals(dave), expectedRemove);


    }

    // ═══════════════════════════════════════════════════════
    //               RESOLUTION — NO QUORUM
    // ═══════════════════════════════════════════════════════

    function test_resolve_noQuorum_partialVotes() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/1000000000000000075");
        _vote(bob, itemId, true);
        _vote(carol, itemId, false);

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        registry.resolve(itemId);

        (,,,,,,, FeedRegistryV2.ItemStatus status) = registry.items(itemId);
        assertEq(uint8(status), uint8(FeedRegistryV2.ItemStatus.Rejected));

        assertEq(registry.pendingWithdrawals(alice), BOND);

        _claim(bob, itemId);
        _claim(carol, itemId);
        assertEq(registry.pendingWithdrawals(bob), VOTE_COST);
        assertEq(registry.pendingWithdrawals(carol), VOTE_COST);


    }

    function test_resolve_noQuorum_zeroVotes() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/1000000000000000076");
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        registry.resolve(itemId);

        (,,,,,,, FeedRegistryV2.ItemStatus status) = registry.items(itemId);
        assertEq(uint8(status), uint8(FeedRegistryV2.ItemStatus.Rejected));
        assertEq(registry.pendingWithdrawals(alice), BOND);

    }

    function test_resolve_noQuorum_singleVoter() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/1000000000000000077");
        _vote(bob, itemId, true);

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        registry.resolve(itemId);

        assertEq(registry.pendingWithdrawals(alice), BOND);
        _claim(bob, itemId);
        assertEq(registry.pendingWithdrawals(bob), VOTE_COST);

    }

    // ═══════════════════════════════════════════════════════
    //               RESOLUTION — GUARDS
    // ═══════════════════════════════════════════════════════

    function test_resolve_votingActive() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/1000000000000000078");
        vm.expectRevert(FeedRegistryV2.VotingPeriodActive.selector);
        registry.resolve(itemId);
    }

    function test_resolve_alreadyResolved() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/1000000000000000079");
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        registry.resolve(itemId);
        vm.expectRevert(FeedRegistryV2.InvalidItemStatus.selector);
        registry.resolve(itemId);
    }

    function test_resolve_nonexistentItem() public {
        vm.expectRevert(FeedRegistryV2.ItemNotFound.selector);
        registry.resolve(999);
    }

    // ═══════════════════════════════════════════════════════
    //                  CLAIM — GUARDS
    // ═══════════════════════════════════════════════════════

    function test_claim_notAVoter() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/1000000000000000100");
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        registry.resolve(itemId);

        vm.prank(bob);
        vm.expectRevert(FeedRegistryV2.NotAVoter.selector);
        registry.claim(itemId);
    }

    function test_claim_doubleClaim() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/1000000000000000101");
        _vote(bob, itemId, true);
        _vote(carol, itemId, true);
        _vote(dave, itemId, true);

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        registry.resolve(itemId);

        _claim(bob, itemId);

        vm.prank(bob);
        vm.expectRevert(FeedRegistryV2.AlreadyClaimed.selector);
        registry.claim(itemId);
    }

    function test_claim_beforeResolve() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/1000000000000000102");
        _vote(bob, itemId, true);

        // Item still in Voting status
        vm.prank(bob);
        vm.expectRevert(FeedRegistryV2.InvalidItemStatus.selector);
        registry.claim(itemId);
    }

    function test_claim_nonexistentItem() public {
        vm.prank(bob);
        vm.expectRevert(FeedRegistryV2.ItemNotFound.selector);
        registry.claim(999);
    }

    function test_claim_loserGetsZero() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/1000000000000000103");
        _vote(bob, itemId, true);
        _vote(carol, itemId, true);
        _vote(dave, itemId, false); // loser

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        registry.resolve(itemId);

        uint256 daveBefore = registry.pendingWithdrawals(dave);
        _claim(dave, itemId);
        // Loser's claim adds 0 to pendingWithdrawals
        assertEq(registry.pendingWithdrawals(dave), daveBefore);
    }

    // ═══════════════════════════════════════════════════════
    //                     WITHDRAWAL
    // ═══════════════════════════════════════════════════════

    function test_withdraw_success() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/1000000000000000080");
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        registry.resolve(itemId);

        uint256 balBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit FeedRegistryV2.Withdrawal(alice, BOND);
        registry.withdraw();

        assertEq(usdc.balanceOf(alice), balBefore + BOND);
        assertEq(registry.pendingWithdrawals(alice), 0);
    }

    function test_withdraw_nothingToWithdraw() public {
        vm.prank(alice);
        vm.expectRevert(FeedRegistryV2.NothingToWithdraw.selector);
        registry.withdraw();
    }

    // ═══════════════════════════════════════════════════════
    //                       ADMIN
    // ═══════════════════════════════════════════════════════

    function test_admin_setBondAmount() public {
        vm.expectEmit(false, false, false, true);
        emit FeedRegistryV2.ParameterUpdated("bondAmount", 2e6);
        registry.setBondAmount(2e6);
        assertEq(registry.bondAmount(), 2e6);
    }

    function test_admin_setVoteCost() public {
        registry.setVoteCost(100_000);
        assertEq(registry.voteCost(), 100_000);
    }

    function test_admin_setVotingPeriod() public {
        registry.setVotingPeriod(2 hours);
        assertEq(registry.votingPeriod(), 2 hours);
    }

    function test_admin_setMinVotes() public {
        registry.setMinVotes(5);
        assertEq(registry.minVotes(), 5);
    }

    function test_admin_setMaxDailySubmissions() public {
        registry.setMaxDailySubmissions(10);
        assertEq(registry.maxDailySubmissions(), 10);
    }

    function test_admin_setAgentBook() public {
        MockAgentBook newBook = new MockAgentBook();
        vm.expectEmit(true, true, false, true);
        emit FeedRegistryV2.AgentBookUpdated(address(agentBook), address(newBook));
        registry.setAgentBook(IAgentBook(address(newBook)));
        assertEq(address(registry.agentBook()), address(newBook));
    }

    function test_admin_setAgentBook_zeroAddress() public {
        vm.expectRevert(FeedRegistryV2.ZeroAddress.selector);
        registry.setAgentBook(IAgentBook(address(0)));
    }

    function test_admin_transferOwnership() public {
        vm.expectEmit(true, true, false, true);
        emit FeedRegistryV2.OwnershipTransferred(address(this), alice);
        registry.transferOwnership(alice);
        assertEq(registry.owner(), alice);
    }

    function test_admin_nonOwnerReverts() public {
        vm.prank(alice);
        vm.expectRevert(FeedRegistryV2.NotOwner.selector);
        registry.setBondAmount(2e6);
    }

    // ═══════════════════════════════════════════════════════
    //                        UUPS
    // ═══════════════════════════════════════════════════════

    function test_uups_ownerUpgrade() public {
        FeedRegistryV2 newImpl = new FeedRegistryV2();
        registry.upgradeToAndCall(address(newImpl), "");
        assertEq(registry.owner(), address(this));
        assertEq(registry.bondAmount(), BOND);
    }

    function test_uups_nonOwnerReverts() public {
        FeedRegistryV2 newImpl = new FeedRegistryV2();
        vm.prank(alice);
        vm.expectRevert(FeedRegistryV2.NotOwner.selector);
        registry.upgradeToAndCall(address(newImpl), "");
    }

    // ═══════════════════════════════════════════════════════
    //                     ECONOMICS
    // ═══════════════════════════════════════════════════════

    function test_economics_balanceInvariant() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/1000000000000000090");
        _vote(bob, itemId, true);
        _vote(carol, itemId, true);
        _vote(dave, itemId, false);

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        registry.resolve(itemId);

        // Claim all
        _claim(bob, itemId);
        _claim(carol, itemId);
        _claim(dave, itemId);

        uint256 totalIn = BOND + 3 * VOTE_COST;
        uint256 totalClaimable =
            registry.pendingWithdrawals(alice) +
            registry.pendingWithdrawals(bob) +
            registry.pendingWithdrawals(carol) +
            registry.pendingWithdrawals(dave);

        uint256 dust = totalIn - totalClaimable;
        assertEq(usdc.balanceOf(address(registry)), totalIn);
        assertLt(dust, 10);
    }

    function test_economics_fullMultiItemCycle() public {
        // Item 1: keep wins
        uint256 id1 = _submit(alice, "https://x.com/user/status/1000000000000000091");
        _vote(bob, id1, true);
        _vote(carol, id1, true);
        _vote(dave, id1, false);

        // Item 2: remove wins
        uint256 id2 = _submit(bob, "https://x.com/user/status/1000000000000000092");
        _vote(carol, id2, false);
        _vote(dave, id2, false);
        _vote(eve, id2, true);

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        registry.resolve(id1);
        registry.resolve(id2);

        // Everyone claims both items
        _claim(bob, id1);
        _claim(carol, id1);
        _claim(dave, id1);
        _claim(carol, id2);
        _claim(dave, id2);
        _claim(eve, id2);

        // Verify everyone can withdraw
        address[5] memory users = [alice, bob, carol, dave, eve];
        for (uint256 i = 0; i < users.length; i++) {
            uint256 pending = registry.pendingWithdrawals(users[i]);
            if (pending > 0) {
                uint256 balBefore = usdc.balanceOf(users[i]);
                vm.prank(users[i]);
                registry.withdraw();
                assertEq(usdc.balanceOf(users[i]), balBefore + pending);
            }
        }
    }

    // ═══════════════════════════════════════════════════════
    //                   SNAPSHOT TESTS
    // ═══════════════════════════════════════════════════════

    function test_voteCostSnapshot_lockedAtSubmission() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/1000000000000000096");
        registry.setVoteCost(200_000);
        uint256 bobBefore = usdc.balanceOf(bob);
        _vote(bob, itemId, true);
        assertEq(usdc.balanceOf(bob), bobBefore - VOTE_COST);
    }

    function test_submitterHumanId_snapshotPreventsbypass() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/1000000000000000097");

        // Someone with alice's original humanId (1) tries to vote — blocked
        address aliceAlt = makeAddr("aliceAlt2");
        agentBook.setHumanId(aliceAlt, 1);
        usdc.mint(aliceAlt, 100e6);
        vm.prank(aliceAlt);
        usdc.approve(address(registry), type(uint256).max);

        vm.prank(aliceAlt);
        vm.expectRevert(FeedRegistryV2.SelfVote.selector);
        registry.vote(itemId, true);
    }

    // ═══════════════════════════════════════════════════════
    //               VOTE WITH PROOF (V2.2)
    // ═══════════════════════════════════════════════════════

    uint256[8] DUMMY_PROOF = [uint256(0), 0, 0, 0, 0, 0, 0, 0];

    function _voteWithProof(address voter, uint256 itemId, bool support, uint256 nullifierHash) internal {
        vm.prank(voter);
        registry.voteWithProof(itemId, support, 0, nullifierHash, DUMMY_PROOF);
    }

    function test_initializeV2_2_setsState() public view {
        assertEq(address(registry.worldIdRouter()), address(mockWorldIdRouter));
        assertEq(registry.groupId(), WORLD_ID_GROUP);
        assertEq(registry.externalNullifierHash(), EXT_NULLIFIER);
    }

    function test_initializeV2_2_cannotReinitialize() public {
        vm.expectRevert();
        registry.initializeV2_2(IWorldIDGroups(address(mockWorldIdRouter)), WORLD_ID_GROUP, EXT_NULLIFIER);
    }

    function test_voteWithProof_happyPath() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/2000000000000000001");
        uint256 frankBefore = usdc.balanceOf(frank);
        uint256 nullifier = 999;

        vm.prank(frank);
        vm.expectEmit(true, true, false, true);
        emit FeedRegistryV2.VoteCastWithProof(itemId, nullifier, true, frank);
        registry.voteWithProof(itemId, true, 0, nullifier, DUMMY_PROOF);

        (uint256 votesFor, uint256 votesAgainst,,) = registry.getVoteSession(itemId);
        assertEq(votesFor, 1);
        assertEq(votesAgainst, 0);
        assertEq(usdc.balanceOf(frank), frankBefore - VOTE_COST);
        assertEq(uint8(registry.voterSide(itemId, frank)), uint8(FeedRegistryV2.VoteSide.Keep));
        assertTrue(registry.hasVotedByHuman(itemId, nullifier));
    }

    function test_voteWithProof_selfVoteBlocked() public {
        // Alice's humanId is 1 (from AgentBook). Submit gives submitterHumanId = 1.
        uint256 itemId = _submit(alice, "https://x.com/user/status/2000000000000000002");

        // Frank tries to vote with nullifierHash = 1 (same as alice's humanId) → SelfVote
        vm.prank(frank);
        vm.expectRevert(FeedRegistryV2.SelfVote.selector);
        registry.voteWithProof(itemId, true, 0, 1, DUMMY_PROOF);
    }

    function test_voteWithProof_doubleVoteBlocked() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/2000000000000000003");
        uint256 nullifier = 888;

        _voteWithProof(frank, itemId, true, nullifier);

        // Same nullifierHash from a different address → AlreadyVoted
        address grace = makeAddr("grace");
        usdc.mint(grace, 100e6);
        vm.prank(grace);
        usdc.approve(address(registry), type(uint256).max);

        vm.prank(grace);
        vm.expectRevert(FeedRegistryV2.AlreadyVoted.selector);
        registry.voteWithProof(itemId, false, 0, nullifier, DUMMY_PROOF);
    }

    function test_voteWithProof_crossPathDoubleVoteBlocked() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/2000000000000000004");

        // Bob votes via AgentBook (humanId = 2)
        _vote(bob, itemId, true);

        // Frank tries to vote with nullifierHash = 2 (same as bob's humanId) → AlreadyVoted
        vm.prank(frank);
        vm.expectRevert(FeedRegistryV2.AlreadyVoted.selector);
        registry.voteWithProof(itemId, false, 0, 2, DUMMY_PROOF);
    }

    function test_voteWithProof_invalidProofReverts() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/2000000000000000005");

        mockWorldIdRouter.setShouldRevert(true);

        vm.prank(frank);
        vm.expectRevert("invalid proof");
        registry.voteWithProof(itemId, true, 0, 777, DUMMY_PROOF);

        // Reset for other tests
        mockWorldIdRouter.setShouldRevert(false);
    }

    function test_voteWithProof_selfVoteByAddress() public {
        // Enable open submissions so submitter gets pseudo-humanId
        registry.setOpenSubmissions(true);

        // Frank submits (not in AgentBook, so humanId = uint160(frank))
        usdc.mint(frank, 100e6);
        vm.prank(frank);
        registry.submitItem("https://x.com/user/status/2000000000000000010", "QmTest");
        uint256 itemId = registry.nextItemId() - 1;

        // Frank tries to vote on own item via voteWithProof — blocked by address check
        vm.prank(frank);
        vm.expectRevert(FeedRegistryV2.SelfVote.selector);
        registry.voteWithProof(itemId, true, 0, 777, DUMMY_PROOF);
    }

    function test_submit_urlMaxLength() public {
        // Build a URL that exceeds 280 chars
        string memory longUrl = "https://x.com/user/status/";
        // Pad to >280
        bytes memory padded = new bytes(300);
        bytes memory prefix = bytes(longUrl);
        for (uint256 i = 0; i < prefix.length; i++) padded[i] = prefix[i];
        for (uint256 i = prefix.length; i < 300; i++) padded[i] = "1";

        vm.prank(alice);
        vm.expectRevert(FeedRegistryV2.InvalidUrl.selector);
        registry.submitItem(string(padded), "QmHash");
    }

    function test_submit_metadataMaxLength() public {
        // Build metadata that exceeds 100 chars
        bytes memory longMeta = new bytes(101);
        for (uint256 i = 0; i < 101; i++) longMeta[i] = "a";

        vm.prank(alice);
        vm.expectRevert(FeedRegistryV2.InvalidUrl.selector);
        registry.submitItem("https://x.com/user/status/2000000000000000011", string(longMeta));
    }

    function test_resolve_rejectedUrlCanBeResubmitted() public {
        string memory url = "https://x.com/user/status/2000000000000000012";
        uint256 itemId = _submit(alice, url);

        // Vote to remove
        _vote(bob, itemId, false);
        _vote(carol, itemId, false);
        _vote(dave, itemId, false);

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        registry.resolve(itemId);

        // Verify rejected
        (,,,,,,, FeedRegistryV2.ItemStatus status) = registry.items(itemId);
        assertEq(uint8(status), uint8(FeedRegistryV2.ItemStatus.Rejected));

        // Same URL can now be resubmitted
        uint256 itemId2 = _submit(bob, url);
        assertEq(itemId2, itemId + 1);
    }

    function test_resolve_acceptedUrlCannotBeResubmitted() public {
        string memory url = "https://x.com/user/status/2000000000000000013";
        uint256 itemId = _submit(alice, url);

        // Vote to keep (supermajority)
        _vote(bob, itemId, true);
        _vote(carol, itemId, true);
        _vote(dave, itemId, true);

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        registry.resolve(itemId);

        // Same URL cannot be resubmitted (it was accepted)
        vm.prank(bob);
        vm.expectRevert(FeedRegistryV2.DuplicateUrl.selector);
        registry.submitItem(url, "QmHash");
    }

    function test_voteWithProof_mixedVoters_resolveAndClaim() public {
        uint256 itemId = _submit(alice, "https://x.com/user/status/2000000000000000006");

        // bob votes keep via AgentBook (humanId=2)
        _vote(bob, itemId, true);
        // carol votes keep via AgentBook (humanId=3)
        _vote(carol, itemId, true);
        // frank votes remove via proof (nullifier=100)
        _voteWithProof(frank, itemId, false, 100);

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        registry.resolve(itemId);

        (,,,,,,, FeedRegistryV2.ItemStatus status) = registry.items(itemId);
        assertEq(uint8(status), uint8(FeedRegistryV2.ItemStatus.Accepted));

        // Submitter gets bond back
        assertEq(registry.pendingWithdrawals(alice), BOND);

        // Keep voters split frank's stake
        (, , uint256 keepClaim, uint256 removeClaim) = registry.getVoteSession(itemId);
        assertEq(keepClaim, VOTE_COST + (1 * VOTE_COST) / 2);
        assertEq(removeClaim, 0);

        _claim(bob, itemId);
        _claim(carol, itemId);
        _claim(frank, itemId);

        assertEq(registry.pendingWithdrawals(bob), keepClaim);
        assertEq(registry.pendingWithdrawals(carol), keepClaim);
        assertEq(registry.pendingWithdrawals(frank), 0);
    }
}
