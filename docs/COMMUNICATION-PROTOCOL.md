# Bridge Communication Protocol Specification

**Current Protocol Version**: `1.0.0`  
**Minimum Supported Version**: `1.0.0`

This specification defines the communication format, versioning, message envelopes, and request/response patterns used between the Bridge Chrome Extension and the Bridge Desktop Application.

---

## 1. Transport & Architecture

Communication between the Chrome extension and the Desktop application operates over local HTTP loopback (`http://127.0.0.1:<port>`).

- **Base URL**: `http://127.0.0.1:49152` (or user-configured dynamic port)
- **Headers**:
  - `Content-Type`: `application/json`
  - `Authorization`: `Bearer <PAIRING_TOKEN>`

---

## 2. Protocol Versioning & Compatibility

Every message payload exchanged uses semantic versioning (`MAJOR.MINOR.PATCH`).

- Breaking protocol changes increment the `MAJOR` version.
- Non-breaking extensions increment `MINOR` or `PATCH`.
- Desktop and Extension negotiate compatibility during the initial handshake:
  ```ts
  export function isProtocolCompatible(version: string): boolean {
    const [major] = version.split('.');
    const [currentMajor] = BRIDGE_PROTOCOL_VERSION.split('.');
    return major === currentMajor;
  }
  ```

---

## 3. Standard Message Envelope

All messages adhere to a standardized envelope format:

```json
{
  "version": "1.0.0",
  "id": "e2a14917-8e65-4f40-8f24-2c35b6bceb75",
  "type": "bridge:apply_changes_request",
  "timestamp": 1729080000000,
  "payload": { ... }
}
```

### Fields
| Field | Type | Description |
| :--- | :--- | :--- |
| `version` | `string` | Semantic protocol version (e.g. `"1.0.0"`). |
| `id` | `string` (UUID v4) | Unique message identifier for request/response correlation. |
| `type` | `string` | Constant identifier describing the message intent. |
| `timestamp` | `number` | Unix epoch time in milliseconds. |
| `payload` | `object` | Typed message payload validated by Zod schema. |

---

## 4. Message Types & Workflows

### 4.1 Health Check (`GET /health`)
Used by the extension to test basic loopback connectivity.

**Response (200 OK)**:
```json
{
  "status": "ok",
  "version": "1.0.0",
  "workspace": true
}
```

---

### 4.2 Handshake Workflow (`POST /api/v1/handshake`)
Initial handshake establishing client identity and validating pairing credentials.

**Request (`bridge:handshake_request`)**:
```json
{
  "version": "1.0.0",
  "id": "7f8c0576-8092-411a-8531-15cbf3f6312a",
  "type": "bridge:handshake_request",
  "timestamp": 1729080000000,
  "payload": {
    "clientName": "BridgeChromeExtension",
    "clientVersion": "0.1.0",
    "token": "7a3f81e9b..."
  }
}
```

**Success Response (`bridge:handshake_response`)**:
```json
{
  "version": "1.0.0",
  "id": "0d99ba79-1b37-4d92-9477-765f02f83195",
  "type": "bridge:handshake_response",
  "timestamp": 1729080001000,
  "payload": {
    "authenticated": true,
    "serverVersion": "1.0.0",
    "workspacePath": "/Users/developer/Projects/my-app"
  }
}
```

---

### 4.3 Apply Changes Workflow (`POST /api/v1/apply`)
Submits a batch of parsed file modifications to be applied to the active workspace.

**Request (`bridge:apply_changes_request`)**:
```json
{
  "version": "1.0.0",
  "id": "c138f28c-d67b-4ef1-9442-999335f61763",
  "type": "bridge:apply_changes_request",
  "timestamp": 1729080002000,
  "payload": {
    "batchId": "a93bc410-6379-4d83-9b92-4d27196eb009",
    "changes": [
      {
        "path": "src/components/Header.tsx",
        "action": "modify",
        "content": "export const Header = () => <header>New</header>;"
      },
      {
        "path": "src/lib/constants.ts",
        "action": "create",
        "content": "export const API_URL = 'http://localhost';"
      }
    ]
  }
}
```

**Success Response (`bridge:apply_changes_response`)**:
```json
{
  "version": "1.0.0",
  "id": "d138f28c-d67b-4ef1-9442-999335f61764",
  "type": "bridge:apply_changes_response",
  "timestamp": 1729080003000,
  "payload": {
    "batchId": "a93bc410-6379-4d83-9b92-4d27196eb009",
    "appliedAt": "2026-10-16T13:30:00.000Z",
    "results": [
      {
        "path": "src/components/Header.tsx",
        "action": "modify",
        "success": true
      },
      {
        "path": "src/lib/constants.ts",
        "action": "create",
        "success": true
      }
    ],
    "canUndo": true
  }
}
```

---

## 5. Error Responses

When an error occurs, the server responds with an appropriate HTTP error status and a structured error body:

```json
{
  "error": "Path traversal violation: target path \"../../secret.txt\" escapes workspace.",
  "code": "PATH_TRAVERSAL_DETECTED",
  "details": {}
}
```

### Standard Error Status Codes
- `400 Bad Request`: Payload failed Zod schema validation or no active workspace is selected.
- `401 Unauthorized`: Missing or invalid bearer token.
- `403 Forbidden`: Origin failed CORS policy or path attempted traversal outside workspace.
- `500 Internal Server Error`: Disk write error or unhandled runtime failure.
