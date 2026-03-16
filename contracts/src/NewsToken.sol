// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title NEWS Token
/// @notice ERC-20 reward token for the Newsworthy registry.
///         Minted by the FeedRegistry when items are accepted.
///         Stakeable for pro-rata x402 query revenue (USDC).
contract NewsToken {
    string public constant name = "Newsworthy";
    string public constant symbol = "NEWS";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public minter; // FeedRegistry

    error OnlyMinter();
    error InsufficientBalance();
    error InsufficientAllowance();

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    event MinterSet(address indexed minter);

    constructor(address _minter) {
        minter = _minter;
        emit MinterSet(_minter);
    }

    function setMinter(address _minter) external {
        if (msg.sender != minter) revert OnlyMinter();
        minter = _minter;
        emit MinterSet(_minter);
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert OnlyMinter();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (balanceOf[msg.sender] < amount) revert InsufficientBalance();
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (balanceOf[from] < amount) revert InsufficientBalance();
        if (allowance[from][msg.sender] < amount) revert InsufficientAllowance();
        balanceOf[from] -= amount;
        allowance[from][msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
