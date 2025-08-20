// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockEthMultiVault {
    event DepositAtom(address receiver, uint256 vaultId, uint256 value);
    event DepositTriple(address receiver, uint256 vaultId, uint256 value);

    receive() external payable {}

    function depositAtom(address receiver, uint256 vaultId) external payable {
        require(msg.value > 0, "no assets");
        emit DepositAtom(receiver, vaultId, msg.value);
    }

    function depositTriple(address receiver, uint256 vaultId) external payable {
        require(msg.value > 0, "no assets");
        emit DepositTriple(receiver, vaultId, msg.value);
    }
}
