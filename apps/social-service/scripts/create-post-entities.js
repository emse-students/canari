
const fs = require("fs");
const path = require("path");

const entitiesDir = path.join(__dirname, "../src/posts/entities");
if (!fs.existsSync(entitiesDir)) {
  fs.mkdirSync(entitiesDir, { recursive: true });
}

fs.writeFileSync(path.join(entitiesDir, "post.entity.ts"), `import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";

@Entity("posts")
export class Post {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column()
  @Index()
  authorId: string;

  @Column("text")
  markdown: string;

  @Column("simple-array", { default: "" })
  mentions: string[];

  @Column("jsonb", { default: [] })
  links: any[];

  @Column({ nullable: true })
  attachedFormId: string;

  @Column("jsonb", { default: [] })
  images: any[];

  @Column("jsonb", { default: [] })
  polls: any[];

  @Column("jsonb", { default: [] })
  eventButtons: any[];

  @Column("jsonb", { default: [] })
  forms: any[];

  @CreateDateColumn()
  @Index()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
`);

