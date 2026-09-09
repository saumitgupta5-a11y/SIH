// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title EvidenceRegistry
/// @notice On-chain chain-of-custody and tamper-evidence layer. Raw document
///         content is deliberately kept off-chain.
contract EvidenceRegistry is AccessControl, Pausable {
    bytes32 public constant OFFICER_ROLE = keccak256("OFFICER_ROLE");
    bytes32 public constant FSL_ROLE = keccak256("FSL_ROLE");
    bytes32 public constant PROSECUTOR_ROLE = keccak256("PROSECUTOR_ROLE");
    bytes32 public constant COURT_ROLE = keccak256("COURT_ROLE");

    enum DocType { FIR, WITNESS_STATEMENT, CHARGESHEET, FORENSIC_REPORT, COURT_ORDER, OTHER }
    enum CaseStatus { OPEN, UNDER_TRIAL, CLOSED, ARCHIVED }

    struct Document { bytes32 caseId; DocType docType; address currentCustodian; bool exists; bool sealed_; }
    struct DocumentVersion { bytes32 documentHash; string metadataURI; uint256 version; address createdBy; uint256 timestamp; }
    struct CustodyEvent { address from; address to; string action; uint256 timestamp; }

    mapping(bytes32 => Document) private documents;
    mapping(bytes32 => DocumentVersion[]) private documentVersions;
    mapping(bytes32 => CustodyEvent[]) private custodyHistory;
    mapping(bytes32 => bytes32[]) private caseDocuments;
    mapping(bytes32 => CaseStatus) public caseStatus;
    mapping(bytes32 => bool) public caseExists;
    mapping(bytes32 => mapping(address => bool)) private accessGranted;

    event DocumentRegistered(bytes32 indexed documentId, bytes32 indexed caseId, DocType docType, bytes32 documentHash, uint256 version, address createdBy, uint256 timestamp);
    event VersionCreated(bytes32 indexed documentId, bytes32 documentHash, string metadataURI, uint256 version, address createdBy, uint256 timestamp);
    event CustodyTransferred(bytes32 indexed documentId, address indexed from, address indexed to, string action, uint256 timestamp);
    event DocumentSealed(bytes32 indexed documentId, address indexed sealedBy, uint256 timestamp);
    event AccessGranted(bytes32 indexed documentId, address indexed grantee, address indexed grantedBy);
    event AccessRevoked(bytes32 indexed documentId, address indexed grantee, address indexed revokedBy);
    event CaseStatusChanged(bytes32 indexed caseId, CaseStatus newStatus, address changedBy);

    modifier documentExists(bytes32 documentId) { require(documents[documentId].exists, "Document does not exist"); _; }
    modifier onlyCustodian(bytes32 documentId) { require(documents[documentId].currentCustodian == msg.sender, "Caller is not the current custodian"); _; }
    modifier notSealed(bytes32 documentId) { require(!documents[documentId].sealed_, "Document is sealed and immutable"); _; }
    modifier caseAllowsChanges(bytes32 documentId) {
        CaseStatus status = caseStatus[documents[documentId].caseId];
        require(status == CaseStatus.OPEN || status == CaseStatus.UNDER_TRIAL, "Case does not allow document changes"); _;
    }

    constructor() { _grantRole(DEFAULT_ADMIN_ROLE, msg.sender); _grantRole(OFFICER_ROLE, msg.sender); }
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    function openCase(bytes32 caseId) external whenNotPaused {
        require(hasRole(OFFICER_ROLE, msg.sender) || hasRole(COURT_ROLE, msg.sender) || hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "Not authorized to open a case");
        require(caseId != bytes32(0), "Invalid case ID");
        require(!caseExists[caseId], "Case already exists");
        caseExists[caseId] = true;
        caseStatus[caseId] = CaseStatus.OPEN;
        emit CaseStatusChanged(caseId, CaseStatus.OPEN, msg.sender);
    }

    function registerDocument(bytes32 documentId, bytes32 caseId, DocType docType, bytes32 documentHash, string calldata metadataURI) external whenNotPaused onlyRole(OFFICER_ROLE) {
        require(!documents[documentId].exists, "Document already exists");
        require(caseExists[caseId], "Case does not exist");
        require(caseStatus[caseId] == CaseStatus.OPEN, "Case is not open");
        require(documentId != bytes32(0), "Invalid document ID");
        require(caseId != bytes32(0), "Invalid case ID");
        require(documentHash != bytes32(0), "Invalid document hash");
        documents[documentId] = Document(caseId, docType, msg.sender, true, false);
        documentVersions[documentId].push(DocumentVersion(documentHash, metadataURI, 1, msg.sender, block.timestamp));
        caseDocuments[caseId].push(documentId);
        accessGranted[documentId][msg.sender] = true;
        emit DocumentRegistered(documentId, caseId, docType, documentHash, 1, msg.sender, block.timestamp);
    }

    function addVersion(bytes32 documentId, bytes32 newHash, string calldata metadataURI) external whenNotPaused documentExists(documentId) onlyCustodian(documentId) notSealed(documentId) caseAllowsChanges(documentId) {
        require(newHash != bytes32(0), "Invalid document hash");
        uint256 newVersion = documentVersions[documentId].length + 1;
        documentVersions[documentId].push(DocumentVersion(newHash, metadataURI, newVersion, msg.sender, block.timestamp));
        emit VersionCreated(documentId, newHash, metadataURI, newVersion, msg.sender, block.timestamp);
    }

    function sealDocument(bytes32 documentId) external whenNotPaused documentExists(documentId) onlyRole(COURT_ROLE) {
        require(!documents[documentId].sealed_, "Document already sealed"); documents[documentId].sealed_ = true;
        emit DocumentSealed(documentId, msg.sender, block.timestamp);
    }

    function transferCustody(bytes32 documentId, address to, string calldata action) external whenNotPaused documentExists(documentId) onlyCustodian(documentId) notSealed(documentId) caseAllowsChanges(documentId) {
        require(to != address(0), "Invalid recipient"); require(to != msg.sender, "Already the current custodian");
        require(hasRole(OFFICER_ROLE, to) || hasRole(FSL_ROLE, to) || hasRole(PROSECUTOR_ROLE, to) || hasRole(COURT_ROLE, to), "Recipient is not an authorized case participant");
        custodyHistory[documentId].push(CustodyEvent(msg.sender, to, action, block.timestamp));
        documents[documentId].currentCustodian = to; accessGranted[documentId][to] = true;
        emit CustodyTransferred(documentId, msg.sender, to, action, block.timestamp);
    }

    function grantAccess(bytes32 documentId, address grantee) external whenNotPaused documentExists(documentId) {
        require(grantee != address(0), "Invalid grantee");
        require(documents[documentId].currentCustodian == msg.sender || hasRole(COURT_ROLE, msg.sender) || hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "Not authorized to grant access");
        accessGranted[documentId][grantee] = true; emit AccessGranted(documentId, grantee, msg.sender);
    }
    function revokeAccess(bytes32 documentId, address grantee) external whenNotPaused documentExists(documentId) {
        require(grantee != address(0), "Invalid grantee");
        require(grantee != documents[documentId].currentCustodian, "Cannot revoke current custodian access");
        require(documents[documentId].currentCustodian == msg.sender || hasRole(COURT_ROLE, msg.sender) || hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "Not authorized to revoke access");
        accessGranted[documentId][grantee] = false; emit AccessRevoked(documentId, grantee, msg.sender);
    }
    function hasAccess(bytes32 documentId, address who) external view documentExists(documentId) returns (bool) { return accessGranted[documentId][who]; }

    function hasAccessBatch(bytes32[] calldata documentIds, address who) external view returns (bool[] memory) {
        bool[] memory result = new bool[](documentIds.length);
        for (uint256 i = 0; i < documentIds.length; i++) {
            if (documents[documentIds[i]].exists) result[i] = accessGranted[documentIds[i]][who];
        }
        return result;
    }

    function getCaseStatuses(bytes32[] calldata caseIds) external view returns (CaseStatus[] memory) {
        CaseStatus[] memory result = new CaseStatus[](caseIds.length);
        for (uint256 i = 0; i < caseIds.length; i++) result[i] = caseStatus[caseIds[i]];
        return result;
    }

    function setCaseStatus(bytes32 caseId, CaseStatus status) external whenNotPaused {
        require(caseExists[caseId], "Case does not exist");
        require(hasRole(COURT_ROLE, msg.sender) || hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "Only court or admin can change case status");
        caseStatus[caseId] = status; emit CaseStatusChanged(caseId, status, msg.sender);
    }
    function getAllVersions(bytes32 documentId) external view documentExists(documentId) returns (DocumentVersion[] memory) { return documentVersions[documentId]; }
    function getLatestVersion(bytes32 documentId) external view documentExists(documentId) returns (bytes32, string memory, uint256, address, uint256) {
        DocumentVersion memory latest = documentVersions[documentId][documentVersions[documentId].length - 1];
        return (latest.documentHash, latest.metadataURI, latest.version, latest.createdBy, latest.timestamp);
    }
    function verifyVersion(bytes32 documentId, uint256 versionNumber, bytes32 currentHash) external view documentExists(documentId) returns (bool) {
        require(versionNumber >= 1, "Invalid version number"); require(versionNumber <= documentVersions[documentId].length, "Version does not exist");
        return documentVersions[documentId][versionNumber - 1].documentHash == currentHash;
    }
    function getAllCustodyHistory(bytes32 documentId) external view documentExists(documentId) returns (CustodyEvent[] memory) { return custodyHistory[documentId]; }
    function getDocument(bytes32 documentId) external view documentExists(documentId) returns (bytes32, DocType, address, bool) {
        Document memory d = documents[documentId]; return (d.caseId, d.docType, d.currentCustodian, d.sealed_);
    }
    function getCaseDocuments(bytes32 caseId) external view returns (bytes32[] memory) { return caseDocuments[caseId]; }
}
