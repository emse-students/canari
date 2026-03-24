
const fs = require("fs");
const path = require("path");

const entitiesDir = path.join(__dirname, "../src/forms/entities");
if (!fs.existsSync(entitiesDir)) {
  fs.mkdirSync(entitiesDir, { recursive: true });
}

fs.writeFileSync(path.join(entitiesDir, "form.entity.ts"), `import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";

@Entity("forms")
export class Form {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column()
  @Index()
  ownerId: string;

  @Column()
  title: string;

  @Column({ nullable: true })
  description: string;

  @Column({ default: 0 })
  basePrice: number;

  @Column({ default: "eur" })
  currency: string;

  @Column({ default: "Submit" })
  submitLabel: string;

  @Column({ nullable: true })
  maxSubmissions: number;

  @Column({ default: false })
  requiresPayment: boolean;

  @Column("jsonb", { default: [] })
  items: any[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
`);

fs.writeFileSync(path.join(entitiesDir, "submission.entity.ts"), `import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";

@Entity("submissions")
@Index(["formId", "userId"])
export class Submission {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column()
  @Index()
  formId: string;

  @Column()
  @Index()
  userId: string;

  @Column({ nullable: true })
  email: string;

  @Column("jsonb", { default: {} })
  answers: Record<string, any>;

  @Column({ default: 0 })
  totalPaid: number;

  @Column({ default: "free" })
  paymentStatus: string;

  @Column({ nullable: true })
  stripeSessionId: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
`);

