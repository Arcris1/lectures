# SpriteChat - Database Schema

## Overview

PostgreSQL database with 4 core tables. Designed for efficient message retrieval and real-time delivery.

---

## Entity Relationship Diagram

```
+------------------+       +-------------------------+
|     users        |       |    conversations         |
+------------------+       +-------------------------+
| id (PK)          |       | id (PK, UUID)           |
| name             |       | type (direct/group)      |
| email (unique)   |       | name (nullable)          |
| password         |       | created_at               |
| avatar           |       | updated_at               |
| character_skin   |       +------------+------------+
| status           |                    |
| created_at       |                    |
| updated_at       |                    |
+--------+---------+       +------------v------------+
         |                 | conversation_participants |
         |                 +-------------------------+
         +---------------->| id (PK)                 |
                           | conversation_id (FK)     |
                           | user_id (FK)             |
                           | joined_at                |
                           +-------------------------+
                                        |
                           +------------v------------+
                           |       messages           |
                           +-------------------------+
                           | id (PK, UUID)           |
                           | conversation_id (FK)     |
                           | user_id (FK)             |
                           | content (text)           |
                           | type                     |
                           | sentiment_emotion        |
                           | sentiment_urgency        |
                           | read_at                  |
                           | created_at               |
                           | updated_at               |
                           +-------------------------+
```

---

## Table Definitions

### users

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `BIGINT` | PK, auto-increment | User ID |
| `name` | `VARCHAR(255)` | NOT NULL | Display name |
| `email` | `VARCHAR(255)` | UNIQUE, NOT NULL | Login email |
| `email_verified_at` | `TIMESTAMP` | NULLABLE | Email verification timestamp |
| `password` | `VARCHAR(255)` | NOT NULL | Hashed password |
| `avatar` | `VARCHAR(500)` | NULLABLE | Avatar image URL |
| `character_skin` | `VARCHAR(50)` | DEFAULT 'default' | Selected character skin |
| `status` | `VARCHAR(20)` | DEFAULT 'offline' | online/offline/away |
| `remember_token` | `VARCHAR(100)` | NULLABLE | Laravel remember me |
| `created_at` | `TIMESTAMP` | NOT NULL | Account creation |
| `updated_at` | `TIMESTAMP` | NOT NULL | Last update |

**Indexes:**
- `users_email_unique` on `email`
- `users_status_index` on `status`

---

### conversations

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `UUID` | PK | Conversation ID |
| `type` | `VARCHAR(20)` | NOT NULL | 'direct' or 'group' |
| `name` | `VARCHAR(255)` | NULLABLE | Group name (null for direct) |
| `created_at` | `TIMESTAMP` | NOT NULL | Creation time |
| `updated_at` | `TIMESTAMP` | NOT NULL | Last update |

**Indexes:**
- `conversations_type_index` on `type`
- `conversations_updated_at_index` on `updated_at` (for sorting by recent)

---

### conversation_participants

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `BIGINT` | PK, auto-increment | Record ID |
| `conversation_id` | `UUID` | FK -> conversations.id, CASCADE | Conversation reference |
| `user_id` | `BIGINT` | FK -> users.id, CASCADE | User reference |
| `joined_at` | `TIMESTAMP` | NOT NULL | When user joined |

**Indexes:**
- `cp_conversation_user_unique` on `(conversation_id, user_id)` - UNIQUE
- `cp_user_id_index` on `user_id` (for fetching user's conversations)

---

### messages

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `UUID` | PK | Message ID |
| `conversation_id` | `UUID` | FK -> conversations.id, CASCADE | Conversation reference |
| `user_id` | `BIGINT` | FK -> users.id, CASCADE | Sender reference |
| `content` | `TEXT` | NOT NULL | Message content |
| `type` | `VARCHAR(20)` | DEFAULT 'text' | text/image/emoji |
| `sentiment_emotion` | `VARCHAR(30)` | NULLABLE | AI: happy/sad/urgent/excited/neutral/angry |
| `sentiment_urgency` | `VARCHAR(20)` | NULLABLE | AI: low/medium/high |
| `read_at` | `TIMESTAMP` | NULLABLE | When recipient read it |
| `created_at` | `TIMESTAMP` | NOT NULL | Send time |
| `updated_at` | `TIMESTAMP` | NOT NULL | Last update |

**Indexes:**
- `messages_conversation_created_index` on `(conversation_id, created_at)` - Primary query index
- `messages_user_id_index` on `user_id`
- `messages_sentiment_emotion_index` on `sentiment_emotion` (for AI analytics)

---

## Migration Order

1. `create_users_table` - Add character_skin and status columns
2. `create_conversations_table` - UUID primary key
3. `create_conversation_participants_table` - Junction table
4. `create_messages_table` - With sentiment columns
5. `create_personal_access_tokens_table` - Sanctum (built-in)

---

## Query Patterns

### Get user's conversations (sorted by latest message)

```sql
SELECT c.*,
       m.content as last_message_content,
       m.created_at as last_message_at,
       m.user_id as last_message_user_id
FROM conversations c
JOIN conversation_participants cp ON cp.conversation_id = c.id
LEFT JOIN LATERAL (
    SELECT content, created_at, user_id
    FROM messages
    WHERE conversation_id = c.id
    ORDER BY created_at DESC
    LIMIT 1
) m ON true
WHERE cp.user_id = :current_user_id
ORDER BY COALESCE(m.created_at, c.created_at) DESC;
```

### Get messages (cursor pagination, newest first)

```sql
SELECT m.*, u.name as user_name, u.character_skin
FROM messages m
JOIN users u ON u.id = m.user_id
WHERE m.conversation_id = :conversation_id
  AND m.created_at < :cursor_timestamp
ORDER BY m.created_at DESC
LIMIT 50;
```

### Get unread count per conversation

```sql
SELECT conversation_id, COUNT(*) as unread_count
FROM messages
WHERE conversation_id IN (:user_conversation_ids)
  AND user_id != :current_user_id
  AND read_at IS NULL
GROUP BY conversation_id;
```

### Find existing direct conversation between two users

```sql
SELECT c.id
FROM conversations c
JOIN conversation_participants cp1 ON cp1.conversation_id = c.id AND cp1.user_id = :user1
JOIN conversation_participants cp2 ON cp2.conversation_id = c.id AND cp2.user_id = :user2
WHERE c.type = 'direct'
LIMIT 1;
```
