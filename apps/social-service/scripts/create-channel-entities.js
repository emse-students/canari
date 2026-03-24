
const fs = require("fs");
const path = require("path");

const entitiesDir = path.join(__dirname, "../src/channels/entities");
if (!fs.existsSync(entitiesDir)) {
  fs.mkdirSync(entitiesDir, { recursive: true });
}

fs.writeFileSync(path.join(entitiesDir, "channel-member.entity.ts"), `import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from "typeorm";

@Entity("channel_members")
@Index(["channelId", "userId"], { unique: true })
export class ChannelMember {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column()
  channelId: string;

  @Column()
  workspaceId: string;

  @Column()
  userId: string;

  @Column()
  roleName: string;

  @CreateDateColumn()
  joinedAt: Date;

  @Column({ type: "timestamp", nullable: true })
  leftAt: Date | null;
}
`);

fs.writeFileSync(path.join(entitiesDir, "channel-message.entity.ts"), `import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from "typeorm";

@Entity("channel_messages")
@Index(["channelId", "createdAt"])
export class ChannelMessage {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column()
  channelId: string;

  @Column()
  workspaceId: string;

  @Column()
  senderId: string;

  @Column()
  ciphertext: string;

  @Column()
  nonce: string;

  @Column({ default: 1 })
  keyVersion: number;

  @CreateDateColumn()
  createdAt: Date;
}
`);

fs.writeFileSync(path.join(entitiesDir, "channel-role.entity.ts"), `import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from "typeorm";

@Entity("channel_roles")
@Index(["workspaceId", "name"], { unique: true })
export class ChannelRole {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column()
  workspaceId: string;

  @Column()
  name: string;

  @Column()
  priority: number;

  @Column("simple-array", { default: "" })
  permissions: string[];

  @CreateDateColumn()
  createdAt: Date;
}
`);

fs.writeFileSync(path.join(entitiesDir, "channel.entity.ts"), `import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from "typeorm";

@Entity("channels")
@Index(["workspaceId", "name"], { unique: true })
export class Channel {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column()
  workspaceId: string;

  @Column()
  name: string;

  @Column({ type: "enum", enum: ["public", "private"], default: "public" })
  visibility: "public" | "private";

  @Column({ default: 1 })
  keyVersion: number;

  @Column({ default: false })
  archived: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
`);

fs.writeFileSync(path.join(entitiesDir, "workspace.entity.ts"), `import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from "typeorm";

@Entity("channel_workspaces")
export class Workspace {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ unique: true })
  slug: string;

  @Column()
  name: string;

  @Column()
  createdBy: string;

  @CreateDateColumn()
  createdAt: Date;
}
`);

