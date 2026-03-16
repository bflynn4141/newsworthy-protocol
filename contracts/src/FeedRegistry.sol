// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IAgentBook} from "./interfaces/IAgentBook.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {INewsToken} from "./interfaces/INewsToken.sol";

/// @title Feed Registry
/// @notice A token-curated registry with AgentBook identity gate and voter rewards.
/// @dev Items go through: submit → challenge window → accepted (or challenged → vote → resolve).
///      Bonds are denominated in USDC (or any ERC-20). Users never need ETH (gas via World Chain grants).
contract FeedRegistry {
    ///////////////////////////////////////////////////////////////////////////////
    ///                                  ERRORS                                ///
    //////////////////////////////////////////////////////////////////////////////

    error NotRegistered();
    error DuplicateUrl();
    error InvalidUrl();
    error InvalidItemStatus();
    error InsufficientBond();
    error SelfChallenge();
    error AlreadyVoted();
    error ChallengePeriodActive();
    error ChallengePeriodExpired();
    error VotingPeriodActive();
    error VotingPeriodExpired();
    error QuorumNotMet();
    error QuorumMet();
    error NothingToWithdraw();
    error TransferFailed();
    error DailyLimitReached();
    error NotOwner();
    error ZeroAddress();

    ///////////////////////////////////////////////////////////////////////////////
    ///                                  EVENTS                                ///
    //////////////////////////////////////////////////////////////////////////////

    event ItemSubmitted(uint256 indexed itemId, address indexed submitter, string url);
    event ItemChallenged(uint256 indexed itemId, address indexed challenger);
    event VoteCast(uint256 indexed itemId, uint256 indexed humanId, bool support);
    event ItemResolved(uint256 indexed itemId, ItemStatus status);
    event ItemAccepted(uint256 indexed itemId);
    event Withdrawal(address indexed account, uint256 amount);
    event NewsRewarded(uint256 indexed itemId, address indexed submitter, uint256 amount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ParameterUpdated(string name, uint256 value);

    ///////////////////////////////////////////////////////////////////////////////
    ///                                  TYPES                                 ///
    //////////////////////////////////////////////////////////////////////////////

    enum ItemStatus { Pending, Challenged, Accepted, Rejected }

    struct Item {
        address submitter;
        string url;
        string metadataHash;
        uint256 bond;
        uint256 submittedAt;
        ItemStatus status;
    }

    struct Challenge {
        address challenger;
        uint256 bond;
        uint256 challengedAt;
        uint256 votesFor;       // votes to KEEP
        uint256 votesAgainst;   // votes to REMOVE
        address[] keepVoters;
        address[] removeVoters;
    }

    ///////////////////////////////////////////////////////////////////////////////
    ///                              STATE                                      ///
    //////////////////////////////////////////////////////////////////////////////

    address public owner;
    IAgentBook public immutable agentBook;
    IERC20 public immutable bondToken;      // USDC or other ERC-20
    INewsToken public immutable newsToken;  // $NEWS reward token
    uint256 public bondAmount;
    uint256 public challengePeriod;
    uint256 public votingPeriod;
    uint256 public minVotes;
    uint256 public newsPerItem;             // $NEWS minted per accepted item
    uint256 public maxDailySubmissions;     // per human per day
    uint256 public constant VOTER_SHARE_BPS = 3000; // 30%

    uint256 public nextItemId;
    mapping(uint256 => Item) public items;
    mapping(uint256 => Challenge) public challenges;
    mapping(uint256 => mapping(uint256 => bool)) public hasVotedByHuman;
    mapping(address => uint256) public pendingWithdrawals;
    mapping(bytes32 => bool) public urlSubmitted;
    mapping(uint256 => mapping(uint256 => uint256)) public dailySubmissions; // humanId => day => count

    ///////////////////////////////////////////////////////////////////////////////
    ///                              MODIFIERS                                 ///
    //////////////////////////////////////////////////////////////////////////////

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    ///////////////////////////////////////////////////////////////////////////////
    ///                              CONSTRUCTOR                                ///
    //////////////////////////////////////////////////////////////////////////////

    constructor(
        IAgentBook _agentBook,
        IERC20 _bondToken,
        INewsToken _newsToken,
        uint256 _bondAmount,
        uint256 _challengePeriod,
        uint256 _votingPeriod,
        uint256 _minVotes,
        uint256 _newsPerItem,
        uint256 _maxDailySubmissions
    ) {
        owner = msg.sender;
        agentBook = _agentBook;
        bondToken = _bondToken;
        newsToken = _newsToken;
        bondAmount = _bondAmount;
        challengePeriod = _challengePeriod;
        votingPeriod = _votingPeriod;
        minVotes = _minVotes;
        newsPerItem = _newsPerItem;
        maxDailySubmissions = _maxDailySubmissions;
    }

    ///////////////////////////////////////////////////////////////////////////////
    ///                              ADMIN                                      ///
    //////////////////////////////////////////////////////////////////////////////

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setBondAmount(uint256 _bondAmount) external onlyOwner {
        bondAmount = _bondAmount;
        emit ParameterUpdated("bondAmount", _bondAmount);
    }

    function setChallengePeriod(uint256 _challengePeriod) external onlyOwner {
        challengePeriod = _challengePeriod;
        emit ParameterUpdated("challengePeriod", _challengePeriod);
    }

    function setVotingPeriod(uint256 _votingPeriod) external onlyOwner {
        votingPeriod = _votingPeriod;
        emit ParameterUpdated("votingPeriod", _votingPeriod);
    }

    function setMinVotes(uint256 _minVotes) external onlyOwner {
        minVotes = _minVotes;
        emit ParameterUpdated("minVotes", _minVotes);
    }

    function setNewsPerItem(uint256 _newsPerItem) external onlyOwner {
        newsPerItem = _newsPerItem;
        emit ParameterUpdated("newsPerItem", _newsPerItem);
    }

    function setMaxDailySubmissions(uint256 _maxDailySubmissions) external onlyOwner {
        maxDailySubmissions = _maxDailySubmissions;
        emit ParameterUpdated("maxDailySubmissions", _maxDailySubmissions);
    }

    ///////////////////////////////////////////////////////////////////////////////
    ///                              SUBMIT                                     ///
    //////////////////////////////////////////////////////////////////////////////

    /// @notice Submit an item to the registry. URL must be a tweet (x.com or twitter.com).
    ///         Caller must have approved bondAmount of bondToken to this contract.
    /// @param url The URL of the content being submitted
    /// @param metadataHash An IPFS hash or other metadata reference
    function submitItem(string calldata url, string calldata metadataHash) external {
        uint256 humanId = agentBook.lookupHuman(msg.sender);
        if (humanId == 0) revert NotRegistered();
        if (!_isTweetUrl(url)) revert InvalidUrl();

        // Enforce daily submission limit per human
        uint256 today = block.timestamp / 1 days;
        if (dailySubmissions[humanId][today] >= maxDailySubmissions) revert DailyLimitReached();
        dailySubmissions[humanId][today]++;

        bytes32 urlHash = keccak256(bytes(url));
        if (urlSubmitted[urlHash]) revert DuplicateUrl();

        // Pull bond from sender
        if (!bondToken.transferFrom(msg.sender, address(this), bondAmount)) revert TransferFailed();

        uint256 itemId = nextItemId++;

        items[itemId] = Item({
            submitter: msg.sender,
            url: url,
            metadataHash: metadataHash,
            bond: bondAmount,
            submittedAt: block.timestamp,
            status: ItemStatus.Pending
        });

        urlSubmitted[urlHash] = true;

        emit ItemSubmitted(itemId, msg.sender, url);
    }

    ///////////////////////////////////////////////////////////////////////////////
    ///                              CHALLENGE                                  ///
    //////////////////////////////////////////////////////////////////////////////

    /// @notice Challenge a pending item. Requires a matching bond in bondToken.
    ///         Caller must have approved the item's bond amount to this contract.
    /// @param itemId The ID of the item to challenge
    function challengeItem(uint256 itemId) external {
        if (agentBook.lookupHuman(msg.sender) == 0) revert NotRegistered();

        Item storage item = items[itemId];
        if (item.status != ItemStatus.Pending) revert InvalidItemStatus();
        if (block.timestamp > item.submittedAt + challengePeriod) revert ChallengePeriodExpired();

        uint256 challengerHumanId = agentBook.lookupHuman(msg.sender);
        uint256 submitterHumanId = agentBook.lookupHuman(item.submitter);
        if (challengerHumanId == submitterHumanId) revert SelfChallenge();

        // Pull matching bond from challenger
        if (!bondToken.transferFrom(msg.sender, address(this), item.bond)) revert TransferFailed();

        item.status = ItemStatus.Challenged;

        challenges[itemId] = Challenge({
            challenger: msg.sender,
            bond: item.bond,
            challengedAt: block.timestamp,
            votesFor: 0,
            votesAgainst: 0,
            keepVoters: new address[](0),
            removeVoters: new address[](0)
        });

        emit ItemChallenged(itemId, msg.sender);
    }

    ///////////////////////////////////////////////////////////////////////////////
    ///                              VOTING                                     ///
    //////////////////////////////////////////////////////////////////////////////

    /// @notice Vote on a challenged item.
    /// @param itemId The ID of the challenged item
    /// @param support True to keep the item, false to remove it
    function voteOnChallenge(uint256 itemId, bool support) external {
        if (agentBook.lookupHuman(msg.sender) == 0) revert NotRegistered();

        Item storage item = items[itemId];
        if (item.status != ItemStatus.Challenged) revert InvalidItemStatus();

        Challenge storage challenge = challenges[itemId];
        if (block.timestamp > challenge.challengedAt + votingPeriod) revert VotingPeriodExpired();

        uint256 humanId = agentBook.lookupHuman(msg.sender);
        if (hasVotedByHuman[itemId][humanId]) revert AlreadyVoted();

        hasVotedByHuman[itemId][humanId] = true;

        if (support) {
            challenge.votesFor++;
            challenge.keepVoters.push(msg.sender);
        } else {
            challenge.votesAgainst++;
            challenge.removeVoters.push(msg.sender);
        }

        emit VoteCast(itemId, humanId, support);
    }

    ///////////////////////////////////////////////////////////////////////////////
    ///                              RESOLVE                                    ///
    //////////////////////////////////////////////////////////////////////////////

    /// @notice Resolve a challenge that has reached quorum after voting ends.
    /// @param itemId The ID of the challenged item
    function resolveChallenge(uint256 itemId) external {
        Item storage item = items[itemId];
        if (item.status != ItemStatus.Challenged) revert InvalidItemStatus();

        Challenge storage challenge = challenges[itemId];
        if (block.timestamp <= challenge.challengedAt + votingPeriod) revert VotingPeriodActive();

        uint256 totalVotes = challenge.votesFor + challenge.votesAgainst;
        if (totalVotes < minVotes) revert QuorumNotMet();

        uint256 totalPool = item.bond + challenge.bond;
        uint256 voterPool = (totalPool * VOTER_SHARE_BPS) / 10_000;
        uint256 winnerPayout = totalPool - voterPool;

        if (challenge.votesFor >= challenge.votesAgainst) {
            // Keep wins — submitter gets 70%, keepVoters split 30%
            pendingWithdrawals[item.submitter] += winnerPayout;
            _distributeVoterRewards(challenge.keepVoters, voterPool);
            item.status = ItemStatus.Accepted;
            _mintNewsReward(itemId, item.submitter);
        } else {
            // Remove wins — challenger gets 70%, removeVoters split 30%
            pendingWithdrawals[challenge.challenger] += winnerPayout;
            _distributeVoterRewards(challenge.removeVoters, voterPool);
            item.status = ItemStatus.Rejected;
        }

        emit ItemResolved(itemId, item.status);
    }

    /// @notice Resolve a challenge that failed to reach quorum. Both bonds returned.
    /// @param itemId The ID of the challenged item
    function resolveNoQuorum(uint256 itemId) external {
        Item storage item = items[itemId];
        if (item.status != ItemStatus.Challenged) revert InvalidItemStatus();

        Challenge storage challenge = challenges[itemId];
        if (block.timestamp <= challenge.challengedAt + votingPeriod) revert VotingPeriodActive();

        uint256 totalVotes = challenge.votesFor + challenge.votesAgainst;
        if (totalVotes >= minVotes) revert QuorumMet();

        // Return both bonds
        pendingWithdrawals[item.submitter] += item.bond;
        pendingWithdrawals[challenge.challenger] += challenge.bond;

        item.status = ItemStatus.Accepted;

        _mintNewsReward(itemId, item.submitter);

        emit ItemResolved(itemId, ItemStatus.Accepted);
    }

    /// @notice Accept an unchallenged item after the challenge period expires.
    /// @param itemId The ID of the pending item
    function acceptItem(uint256 itemId) external {
        Item storage item = items[itemId];
        if (item.status != ItemStatus.Pending) revert InvalidItemStatus();
        if (block.timestamp <= item.submittedAt + challengePeriod) revert ChallengePeriodActive();

        pendingWithdrawals[item.submitter] += item.bond;
        item.status = ItemStatus.Accepted;

        _mintNewsReward(itemId, item.submitter);

        emit ItemAccepted(itemId);
    }

    ///////////////////////////////////////////////////////////////////////////////
    ///                              WITHDRAW                                   ///
    //////////////////////////////////////////////////////////////////////////////

    /// @notice Withdraw accumulated USDC rewards/bonds.
    function withdraw() external {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        // Checks-effects-interactions: zero out before transfer
        pendingWithdrawals[msg.sender] = 0;

        if (!bondToken.transfer(msg.sender, amount)) revert TransferFailed();

        emit Withdrawal(msg.sender, amount);
    }

    ///////////////////////////////////////////////////////////////////////////////
    ///                              INTERNAL                                   ///
    //////////////////////////////////////////////////////////////////////////////

    /// @dev Mint $NEWS reward to a submitter when their item is accepted.
    function _mintNewsReward(uint256 itemId, address submitter) internal {
        if (newsPerItem == 0) return;
        newsToken.mint(submitter, newsPerItem);
        emit NewsRewarded(itemId, submitter, newsPerItem);
    }

    /// @dev Distribute voter rewards evenly among winning voters.
    function _distributeVoterRewards(address[] storage voters, uint256 totalReward) internal {
        uint256 count = voters.length;
        if (count == 0) return;

        uint256 perVoter = totalReward / count;
        for (uint256 i = 0; i < count; i++) {
            pendingWithdrawals[voters[i]] += perVoter;
        }
        // Dust (totalReward % count) stays in contract — negligible
    }

    /// @dev Check that a URL is a tweet: starts with "https://x.com/" or "https://twitter.com/"
    ///      and contains "/status/" somewhere after the prefix.
    function _isTweetUrl(string calldata url) internal pure returns (bool) {
        bytes calldata b = bytes(url);

        // Minimum valid tweet: "https://x.com/a/status/1" = 25 chars
        if (b.length < 25) return false;

        // Check prefix: "https://x.com/" (14 chars) or "https://twitter.com/" (20 chars)
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

        // Find "/status/" after the prefix
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
}
