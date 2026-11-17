/** Plain data saved from a project's channels before `/project dissolve` deletes them. */

export interface BackupAttachment {
  name: string;
  size: number;
  /** Embedded image (data URI). Only ever produced from our own download, never from message text. */
  dataUri?: string;
  note?: string;
}

export interface BackupEmbed {
  title?: string;
  url?: string;
  description?: string;
  color?: number | null;
  authorName?: string;
  footer?: string;
  fields: { name: string; value: string }[];
}

export interface BackupMessage {
  id: string;
  authorId: string;
  createdAt: string;
  editedAt: string | null;
  content: string;
  replyTo: string | null;
  pinned: boolean;
  embeds: BackupEmbed[];
  attachments: BackupAttachment[];
  reactions: { emoji: string; count: number }[];
  stickers: string[];
  /** Label for system messages (member joined, message pinned, …); null for normal messages. */
  system: string | null;
}

export interface BackupAuthor {
  id: string;
  name: string;
  username: string;
  bot: boolean;
  /** 64 px avatar as a data URI; missing → initials are shown. */
  avatar?: string;
}

export interface BackupChannel {
  id: string;
  name: string;
  category: string;
  kind: "text" | "voice" | "thread";
  /** Parent channel name, for threads and forum posts. */
  parent?: string;
  messages: BackupMessage[];
}

export interface BackupData {
  project: string;
  dissolvedAt: string;
  dissolvedBy: string;
  channels: BackupChannel[];
  authors: Record<string, BackupAuthor>;
}
