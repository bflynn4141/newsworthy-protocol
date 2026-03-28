// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Initializable} from "@openzeppelin-contracts-5.0.2/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin-contracts-5.0.2/proxy/utils/UUPSUpgradeable.sol";
import {IAgentBook} from "./interfaces/IAgentBook.sol";
import {IERC20} from "./interfaces/IERC20.sol";
// INewsToken import removed in V2.5 — $NEWS distribution deprecated
import {IWorldIDGroups} from "./interfaces/IWorldIDGroups.sol";
import {ISignatureTransfer} from "./interfaces/ISignatureTransfer.sol";
import {ByteHasher} from "./utils/ByteHasher.sol";

/// @title Feed Registry V2
/// @notice Token-curated registry with paid voting (prediction market dynamic).
///         Items go through: submit (1 USDC bond) → voting window → resolve.
///         No challenge step — every submission enters a voting window directly.
///         Voters claim payouts individually (O(1) per claim, no gas limit risk).
/// @dev UUPS upgradeable. Deploy behind an ERC1967Proxy.
contract FeedRegistryV2 is Initializable, UUPSUpgradeable {
    using ByteHasher for bytes;

    ///////////////////////////////////////////////////////////////////////////
    ///                                ERRORS                               ///
    ///////////////////////////////////////////////////////////////////////////

    error NotRegistered();
    error DuplicateUrl();
    error InvalidUrl();
    error InvalidItemStatus();
    error ItemNotFound();
    error SelfVote();
    error AlreadyVoted();
    error NotAVoter();
    error AlreadyClaimed();
    error VotingPeriodActive();
    error VotingPeriodExpired();
    error NothingToWithdraw();
    error TransferFailed();
    error DailyLimitReached();
    error NotOwner();
    error ZeroAddress();
    error InvalidProof();

    ///////////////////////////////////////////////////////////////////////////
    ///                                EVENTS                               ///
    ///////////////////////////////////////////////////////////////////////////

    event ItemSubmitted(uint256 indexed itemId, address indexed submitter, string url);
    event VoteCast(uint256 indexed itemId, uint256 indexed humanId, bool support);
    event ItemResolved(uint256 indexed itemId, ItemStatus status);
    event VoterClaimed(uint256 indexed itemId, address indexed voter, uint256 amount);
    event Withdrawal(address indexed account, uint256 amount);
    // NewsRewarded event removed in V2.5 — $NEWS distribution deprecated
    event VoteCastWithProof(uint256 indexed itemId, uint256 indexed nullifierHash, bool support, address voter);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AgentBookUpdated(address indexed previousAgentBook, address indexed newAgentBook);
    event ParameterUpdated(string name, uint256 value);

    ///////////////////////////////////////////////////////////////////////////
    ///                                TYPES                                ///
    ///////////////////////////////////////////////////////////////////////////

    enum ItemStatus { Voting, Accepted, Rejected }
    enum VoteSide { None, Keep, Remove }

    struct Item {
        address submitter;
        uint256 submitterHumanId;
        string url;
        string metadataHash;
        uint256 bond;
        uint256 voteCostSnapshot;
        uint256 submittedAt;
        ItemStatus status;
    }

    struct VoteSession {
        uint256 votesFor;           // votes to KEEP
        uint256 votesAgainst;       // votes to REMOVE
        uint256 keepClaimPerVoter;  // set at resolve: total payout per keep-voter
        uint256 removeClaimPerVoter;// set at resolve: total payout per remove-voter
    }

    ///////////////////////////////////////////////////////////////////////////
    ///                                STATE                                ///
    ///////////////////////////////////////////////////////////////////////////

    address public owner;
    IAgentBook public agentBook;
    IERC20 public bondToken;
    address public __deprecated_newsToken;  // slot preserved for storage layout compatibility
    uint256 public bondAmount;
    uint256 public voteCost;
    uint256 public votingPeriod;
    uint256 public minVotes;
    uint256 public __deprecated_newsPerItem;  // slot preserved for storage layout compatibility
    uint256 public maxDailySubmissions;

    uint256 public nextItemId;
    mapping(uint256 => Item) public items;
    mapping(uint256 => VoteSession) internal _voteSessions;
    mapping(uint256 => mapping(uint256 => bool)) public hasVotedByHuman;
    mapping(address => uint256) public pendingWithdrawals;
    mapping(bytes32 => bool) public urlSubmitted;
    mapping(uint256 => mapping(uint256 => uint256)) public dailySubmissions;
    mapping(uint256 => mapping(address => VoteSide)) public voterSide;
    mapping(uint256 => mapping(address => bool)) public hasClaimed;

    /// @notice When true, submissions skip World ID verification (any address can submit).
    bool public openSubmissions;

    /// @notice World ID router for direct proof verification.
    IWorldIDGroups public worldIdRouter;

    /// @notice World ID group (1 = Orb on World Chain).
    uint256 public groupId;

    /// @notice External nullifier hash shared with AgentBook for cross-path sybil resistance.
    uint256 public externalNullifierHash;

    /// @notice Permit2 contract for gasless token approvals (World App MiniKit).
    ISignatureTransfer public permit2;

    /// @dev Deprecated: was voting whitelist, never enforced. Slot preserved for storage layout.
    mapping(address => bool) public __deprecated_votingWhitelist;

    /// @dev Reserved storage for future upgrades.
    uint256[32] private __gap;

    ///////////////////////////////////////////////////////////////////////////
    ///                              MODIFIERS                              ///
    ///////////////////////////////////////////////////////////////////////////

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    ///////////////////////////////////////////////////////////////////////////
    ///                         CONSTRUCTOR / INIT                          ///
    ///////////////////////////////////////////////////////////////////////////

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        IAgentBook _agentBook,
        IERC20 _bondToken,
        address, // _newsToken deprecated
        uint256 _bondAmount,
        uint256 _voteCost,
        uint256 _votingPeriod,
        uint256 _minVotes,
        uint256, // _newsPerItem deprecated
        uint256 _maxDailySubmissions
    ) external initializer {
        if (address(_agentBook) == address(0) || address(_bondToken) == address(0))
            revert ZeroAddress();
        owner = msg.sender;
        agentBook = _agentBook;
        bondToken = _bondToken;
        bondAmount = _bondAmount;
        voteCost = _voteCost;
        votingPeriod = _votingPeriod;
        minVotes = _minVotes;
        maxDailySubmissions = _maxDailySubmissions;
    }

    /// @notice Initialize V2.2 state: World ID direct verification.
    function initializeV2_2(
        IWorldIDGroups _worldIdRouter,
        uint256 _groupId,
        uint256 _externalNullifierHash
    ) external reinitializer(2) {
        if (address(_worldIdRouter) == address(0)) revert ZeroAddress();
        worldIdRouter = _worldIdRouter;
        groupId = _groupId;
        externalNullifierHash = _externalNullifierHash;
    }

    /// @notice Initialize V2.3 state: Permit2 for gasless voting.
    function initializeV2_3(
        ISignatureTransfer _permit2
    ) external reinitializer(3) {
        if (address(_permit2) == address(0)) revert ZeroAddress();
        permit2 = _permit2;
    }

    /// @notice Initialize V2.4 state (no new params, increments version).
    function initializeV2_4() external reinitializer(4) {}

    /// @notice Initialize V2.5: remove $NEWS distribution, set 6-hour voting period.
    function initializeV2_5() external reinitializer(5) {
        votingPeriod = 21600; // 6 hours
        __deprecated_newsPerItem = 0;
        __deprecated_newsToken = address(0);
    }

    /// @notice Initialize V2.6: stricter resolution (tie=reject, no-quorum=reject).
    function initializeV2_6() external reinitializer(6) {
        // Resolution logic changes are in resolve(), no new state needed
    }

    ///////////////////////////////////////////////////////////////////////////
    ///                                ADMIN                                ///
    ///////////////////////////////////////////////////////////////////////////

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setAgentBook(IAgentBook _agentBook) external onlyOwner {
        if (address(_agentBook) == address(0)) revert ZeroAddress();
        emit AgentBookUpdated(address(agentBook), address(_agentBook));
        agentBook = _agentBook;
    }

    function setBondAmount(uint256 _bondAmount) external onlyOwner {
        bondAmount = _bondAmount;
        emit ParameterUpdated("bondAmount", _bondAmount);
    }

    function setVoteCost(uint256 _voteCost) external onlyOwner {
        voteCost = _voteCost;
        emit ParameterUpdated("voteCost", _voteCost);
    }

    function setVotingPeriod(uint256 _votingPeriod) external onlyOwner {
        votingPeriod = _votingPeriod;
        emit ParameterUpdated("votingPeriod", _votingPeriod);
    }

    function setMinVotes(uint256 _minVotes) external onlyOwner {
        minVotes = _minVotes;
        emit ParameterUpdated("minVotes", _minVotes);
    }

    function setMaxDailySubmissions(uint256 _maxDailySubmissions) external onlyOwner {
        maxDailySubmissions = _maxDailySubmissions;
        emit ParameterUpdated("maxDailySubmissions", _maxDailySubmissions);
    }

    function setOpenSubmissions(bool _open) external onlyOwner {
        openSubmissions = _open;
    }

    function setWorldIdRouter(IWorldIDGroups _worldIdRouter) external onlyOwner {
        if (address(_worldIdRouter) == address(0)) revert ZeroAddress();
        worldIdRouter = _worldIdRouter;
    }

    function setGroupId(uint256 _groupId) external onlyOwner {
        groupId = _groupId;
    }

    function setExternalNullifierHash(uint256 _externalNullifierHash) external onlyOwner {
        externalNullifierHash = _externalNullifierHash;
    }

    function setPermit2(ISignatureTransfer _permit2) external onlyOwner {
        if (address(_permit2) == address(0)) revert ZeroAddress();
        permit2 = _permit2;
    }

    // setVotingWhitelist removed in V2.6 — was never enforced


    ///////////////////////////////////////////////////////////////////////////
    ///                               SUBMIT                                ///
    ///////////////////////////////////////////////////////////////////////////

    /// @notice Submit an item to the registry. URL must be a tweet.
    ///         Caller must have approved bondAmount of bondToken to this contract.
    function submitItem(string calldata url, string calldata metadataHash) external {
        uint256 humanId;
        if (openSubmissions) {
            // Open mode: use address as pseudo-humanId (no World ID required)
            humanId = uint256(uint160(msg.sender));
        } else {
            humanId = agentBook.lookupHuman(msg.sender);
            if (humanId == 0) revert NotRegistered();
        }
        if (!_isTweetUrl(url)) revert InvalidUrl();
        if (bytes(url).length > 280) revert InvalidUrl();
        if (bytes(metadataHash).length > 100) revert InvalidUrl();

        uint256 today = block.timestamp / 1 days;
        if (dailySubmissions[humanId][today] >= maxDailySubmissions) revert DailyLimitReached();
        dailySubmissions[humanId][today]++;

        bytes32 urlHash = keccak256(bytes(url));
        if (urlSubmitted[urlHash]) revert DuplicateUrl();

        if (!bondToken.transferFrom(msg.sender, address(this), bondAmount)) revert TransferFailed();

        uint256 itemId = nextItemId++;

        items[itemId] = Item({
            submitter: msg.sender,
            submitterHumanId: humanId,
            url: url,
            metadataHash: metadataHash,
            bond: bondAmount,
            voteCostSnapshot: voteCost,
            submittedAt: block.timestamp,
            status: ItemStatus.Voting
        });

        urlSubmitted[urlHash] = true;

        emit ItemSubmitted(itemId, msg.sender, url);
    }

    ///////////////////////////////////////////////////////////////////////////
    ///                               VOTING                                ///
    ///////////////////////////////////////////////////////////////////////////

    /// @notice Vote on an item via AgentBook registration. Costs voteCostSnapshot USDC.
    /// @param itemId The ID of the item
    /// @param support True to keep the item, false to remove it
    function vote(uint256 itemId, bool support) external {
        uint256 humanId = agentBook.lookupHuman(msg.sender);
        if (humanId == 0) revert NotRegistered();
        _doVote(itemId, support, humanId, msg.sender);
        emit VoteCast(itemId, humanId, support);
    }

    /// @notice Vote on an item with an inline World ID proof (no AgentBook needed).
    /// @param itemId The ID of the item
    /// @param support True to keep the item, false to remove it
    /// @param root Merkle root of the World ID identity tree
    /// @param nullifierHash World ID nullifier hash (acts as humanId)
    /// @param proof Groth16 proof (uint256[8])
    function voteWithProof(
        uint256 itemId,
        bool support,
        uint256 root,
        uint256 nullifierHash,
        uint256[8] calldata proof
    ) external {
        uint256 signalHash = abi.encodePacked(msg.sender).hashToField();
        worldIdRouter.verifyProof(root, groupId, signalHash, nullifierHash, externalNullifierHash, proof);
        _doVote(itemId, support, nullifierHash, msg.sender);
        emit VoteCastWithProof(itemId, nullifierHash, support, msg.sender);
    }

    /// @notice Vote on an item with World ID proof + Permit2 (for World App MiniKit).
    /// @param itemId The ID of the item
    /// @param support True to keep the item, false to remove it
    /// @param root Merkle root of the World ID identity tree
    /// @param nullifierHash World ID nullifier hash (acts as humanId)
    /// @param proof Groth16 proof (uint256[8])
    /// @param permitAmount Permit2 token amount
    /// @param permitNonce Permit2 nonce
    /// @param permitDeadline Permit2 deadline
    /// @param permitSignature Permit2 signature from the user
    function voteWithProofPermit2(
        uint256 itemId,
        bool support,
        uint256 root,
        uint256 nullifierHash,
        uint256[8] calldata proof,
        uint256 permitAmount,
        uint256 permitNonce,
        uint256 permitDeadline,
        bytes calldata permitSignature
    ) external {
        uint256 signalHash = abi.encodePacked(msg.sender).hashToField();
        worldIdRouter.verifyProof(root, groupId, signalHash, nullifierHash, externalNullifierHash, proof);

        if (itemId >= nextItemId) revert ItemNotFound();
        Item storage item = items[itemId];
        if (item.status != ItemStatus.Voting) revert InvalidItemStatus();
        if (block.timestamp > item.submittedAt + votingPeriod) revert VotingPeriodExpired();
        if (msg.sender == item.submitter) revert SelfVote();
        if (nullifierHash == item.submitterHumanId) revert SelfVote();
        if (hasVotedByHuman[itemId][nullifierHash]) revert AlreadyVoted();
        hasVotedByHuman[itemId][nullifierHash] = true;

        permit2.permitTransferFrom(
            ISignatureTransfer.PermitTransferFrom({
                permitted: ISignatureTransfer.TokenPermissions({token: address(bondToken), amount: permitAmount}),
                nonce: permitNonce,
                deadline: permitDeadline
            }),
            ISignatureTransfer.SignatureTransferDetails({to: address(this), requestedAmount: item.voteCostSnapshot}),
            msg.sender,
            permitSignature
        );

        voterSide[itemId][msg.sender] = support ? VoteSide.Keep : VoteSide.Remove;
        VoteSession storage session = _voteSessions[itemId];
        if (support) { session.votesFor++; } else { session.votesAgainst++; }

        emit VoteCastWithProof(itemId, nullifierHash, support, msg.sender);
    }

    ///////////////////////////////////////////////////////////////////////////
    ///                              RESOLVE                                ///
    ///////////////////////////////////////////////////////////////////////////

    /// @notice Resolve an item after its voting window closes. O(1) gas.
    ///         Requires ≥2:1 supermajority (keep:remove) to accept.
    ///         Contested results (keep majority but <2:1) refund everyone.
    ///         Computes per-voter claim amounts; voters call claim() individually.
    function resolve(uint256 itemId) external {
        if (itemId >= nextItemId) revert ItemNotFound();

        Item storage item = items[itemId];
        if (item.status != ItemStatus.Voting) revert InvalidItemStatus();
        if (block.timestamp <= item.submittedAt + votingPeriod) revert VotingPeriodActive();

        VoteSession storage session = _voteSessions[itemId];
        uint256 totalVotes = session.votesFor + session.votesAgainst;
        uint256 vc = item.voteCostSnapshot;

        if (totalVotes < minVotes) {
            // No quorum — refund everyone, reject
            pendingWithdrawals[item.submitter] += item.bond;
            session.keepClaimPerVoter = vc;
            session.removeClaimPerVoter = vc;
            item.status = ItemStatus.Rejected;
        } else if (session.votesFor >= 2 * session.votesAgainst) {
            // Supermajority keep (≥2:1 ratio) — accepted
            // Keep-voters: refund + split remove-voters' stakes
            pendingWithdrawals[item.submitter] += item.bond;
            session.keepClaimPerVoter = vc
                + (session.votesAgainst > 0 ? (session.votesAgainst * vc) / session.votesFor : 0);
            session.removeClaimPerVoter = 0;
            item.status = ItemStatus.Accepted;
        } else if (session.votesAgainst > session.votesFor) {
            // Remove majority — submitter loses bond
            // Remove-voters: refund + split (bond + keep-voters' stakes)
            session.removeClaimPerVoter = vc + (item.bond + session.votesFor * vc) / session.votesAgainst;
            session.keepClaimPerVoter = 0;
            item.status = ItemStatus.Rejected;
        } else {
            // Contested (keep majority but <2:1) — reject, refund everyone
            pendingWithdrawals[item.submitter] += item.bond;
            session.keepClaimPerVoter = vc;
            session.removeClaimPerVoter = vc;
            item.status = ItemStatus.Rejected;
        }

        // Allow resubmission of rejected URLs (prevents URL squatting)
        if (item.status == ItemStatus.Rejected) {
            urlSubmitted[keccak256(bytes(item.url))] = false;
        }

        emit ItemResolved(itemId, item.status);
    }

    ///////////////////////////////////////////////////////////////////////////
    ///                            CLAIM / WITHDRAW                         ///
    ///////////////////////////////////////////////////////////////////////////

    /// @notice Claim voter payout for a resolved item. Credits pendingWithdrawals.
    function claim(uint256 itemId) external {
        if (itemId >= nextItemId) revert ItemNotFound();

        Item storage item = items[itemId];
        if (item.status == ItemStatus.Voting) revert InvalidItemStatus();

        VoteSide side = voterSide[itemId][msg.sender];
        if (side == VoteSide.None) revert NotAVoter();
        if (hasClaimed[itemId][msg.sender]) revert AlreadyClaimed();

        hasClaimed[itemId][msg.sender] = true;

        VoteSession storage session = _voteSessions[itemId];
        uint256 payout = side == VoteSide.Keep
            ? session.keepClaimPerVoter
            : session.removeClaimPerVoter;

        if (payout > 0) {
            pendingWithdrawals[msg.sender] += payout;
        }

        emit VoterClaimed(itemId, msg.sender, payout);
    }

    /// @notice Withdraw accumulated USDC rewards/bonds.
    function withdraw() external {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        pendingWithdrawals[msg.sender] = 0;

        if (!bondToken.transfer(msg.sender, amount)) revert TransferFailed();

        emit Withdrawal(msg.sender, amount);
    }

    ///////////////////////////////////////////////////////////////////////////
    ///                              VIEWS                                  ///
    ///////////////////////////////////////////////////////////////////////////

    /// @notice Get vote session data and per-voter claim amounts.
    function getVoteSession(uint256 itemId) external view returns (
        uint256 votesFor,
        uint256 votesAgainst,
        uint256 keepClaimPerVoter,
        uint256 removeClaimPerVoter
    ) {
        VoteSession storage s = _voteSessions[itemId];
        return (s.votesFor, s.votesAgainst, s.keepClaimPerVoter, s.removeClaimPerVoter);
    }

    ///////////////////////////////////////////////////////////////////////////
    ///                             INTERNAL                                ///
    ///////////////////////////////////////////////////////////////////////////

    function _doVote(uint256 itemId, bool support, uint256 humanId, address voter) internal {
        if (itemId >= nextItemId) revert ItemNotFound();
        Item storage item = items[itemId];
        if (item.status != ItemStatus.Voting) revert InvalidItemStatus();
        if (block.timestamp > item.submittedAt + votingPeriod) revert VotingPeriodExpired();
        if (voter == item.submitter) revert SelfVote();
        if (humanId == item.submitterHumanId) revert SelfVote();
        if (hasVotedByHuman[itemId][humanId]) revert AlreadyVoted();
        hasVotedByHuman[itemId][humanId] = true;
        if (!bondToken.transferFrom(voter, address(this), item.voteCostSnapshot)) revert TransferFailed();
        voterSide[itemId][voter] = support ? VoteSide.Keep : VoteSide.Remove;
        VoteSession storage session = _voteSessions[itemId];
        if (support) {
            session.votesFor++;
        } else {
            session.votesAgainst++;
        }
    }

    function _isTweetUrl(string calldata url) internal pure returns (bool) {
        bytes calldata b = bytes(url);

        if (b.length < 25) return false;

        bool isX = b.length >= 14
            && b[0] == "h" && b[1] == "t" && b[2] == "t" && b[3] == "p" && b[4] == "s"
            && b[5] == ":" && b[6] == "/" && b[7] == "/"
            && b[8] == "x" && b[9] == "." && b[10] == "c" && b[11] == "o" && b[12] == "m"
            && b[13] == "/";

        bool isTwitter = !isX && b.length >= 20
            && b[0] == "h" && b[1] == "t" && b[2] == "t" && b[3] == "p" && b[4] == "s"
            && b[5] == ":" && b[6] == "/" && b[7] == "/"
            && b[8] == "t" && b[9] == "w" && b[10] == "i" && b[11] == "t" && b[12] == "t"
            && b[13] == "e" && b[14] == "r" && b[15] == "." && b[16] == "c" && b[17] == "o"
            && b[18] == "m" && b[19] == "/";

        if (!isX && !isTwitter) return false;

        uint256 start = isX ? 14 : 20;
        bytes memory needle = "/status/";
        uint256 needleLen = 8;

        for (uint256 i = start; i + needleLen <= b.length; i++) {
            bool found = true;
            for (uint256 j = 0; j < needleLen; j++) {
                if (b[i + j] != needle[j]) {
                    found = false;
                    break;
                }
            }
            if (found) return true;
        }

        return false;
    }

    /// @dev UUPS: only owner can authorize upgrades.
    function _authorizeUpgrade(address) internal override onlyOwner {}
}
