
const fs = require("fs");
const path = require("path");

const servicePath = path.join(__dirname, "../src/channels/channel.service.ts");
let content = fs.readFileSync(servicePath, "utf-8");

// Imports
content = content.replace(/import \{ InjectModel \} from .@nestjs\/mongoose.;/g, `import { InjectRepository } from "@nestjs/typeorm";\nimport { Repository, In, Not } from "typeorm";`);
content = content.replace(/import \{ Model \} from .mongoose.;/g, ``);
content = content.replace(/import .* from .\.\/schemas\/.*/g, ""); // Remove old schema imports (if any, wait they might be used as types)
// Better: just replace the schemas by entities in imports (did that via channels.module.ts already probably? Ah no, channel.service.ts might have them)
content = content.replace(/import \{ ([^}]+) \} from .\.\/schemas\/(.+?)\.schema.;/g, (match, classes) => {
   // Schema exports like "Workspace", "ChannelDocument", etc.
   // I will just let it be missing and add entity imports at the top
   return ``;
});

const entityImports = `
import { Workspace } from "./entities/workspace.entity";
import { Channel } from "./entities/channel.entity";
import { ChannelRole } from "./entities/channel-role.entity";
import { ChannelMember } from "./entities/channel-member.entity";
import { ChannelMessage } from "./entities/channel-message.entity";
`;
content = content.replace(/import \{ Injectable, NotFoundException, ForbiddenException, Logger \} from .\@nestjs\/common.;/, `import { Injectable, NotFoundException, ForbiddenException, Logger } from "@nestjs/common";\n${entityImports}`);

// Constructor
content = content.replace(/@InjectModel\(Workspace\.name\) private workspaceModel: Model<Workspace>/g, `@InjectRepository(Workspace) private readonly workspaceRepo: Repository<Workspace>`);
content = content.replace(/@InjectModel\(Channel\.name\) private channelModel: Model<Channel>/g, `@InjectRepository(Channel) private readonly channelRepo: Repository<Channel>`);
content = content.replace(/@InjectModel\(ChannelRole\.name\) private roleModel: Model<ChannelRole>/g, `@InjectRepository(ChannelRole) private readonly roleRepo: Repository<ChannelRole>`);
content = content.replace(/@InjectModel\(ChannelMember\.name\) private memberModel: Model<ChannelMember>/g, `@InjectRepository(ChannelMember) private readonly memberRepo: Repository<ChannelMember>`);
content = content.replace(/@InjectModel\(ChannelMessage\.name\) private messageModel: Model<ChannelMessage>/g, `@InjectRepository(ChannelMessage) private readonly messageRepo: Repository<ChannelMessage>`);

// Methods
// Creates
content = content.replace(/this\.([a-zA-Z]+)Model\.create\((.+?)\)/g, (match, entityPrefix, args) => {
   return `this.${entityPrefix}Repo.save(this.${entityPrefix}Repo.create(${args}))`;
});

// findById
content = content.replace(/this\.([a-zA-Z]+)Model\.findById\((.+?)\)/g, (match, entityPrefix, id) => {
   return `this.${entityPrefix}Repo.findOne({ where: { id: ${id} } })`;
});

// findOne
content = content.replace(/this\.([a-zA-Z]+)Model\.findOne\(\{ (.*?) \}\)/g, (match, entityPrefix, args) => {
   return `this.${entityPrefix}Repo.findOne({ where: { ${args} } })`;
});

// find
content = content.replace(/this\.([a-zA-Z]+)Model\.find\(\{(.*?)\}\)/g, (match, entityPrefix, args) => {
   return `this.${entityPrefix}Repo.find({ where: {${args}} })`;
});

content = content.replace(/this\.([a-zA-Z]+)Model\.find\(\)/g, (match, entityPrefix) => {
   return `this.${entityPrefix}Repo.find()`;
});

// save() for existing instances
// Usually in Mongoose they do   const doc = await findById(); doc.field = "value"; await doc.save();
// In TypeORM it"s the same or this.repo.save(doc);

// updateOne / updateMany
// findByIdAndUpdate
content = content.replace(/await this\.([a-zA-Z]+)Model\.findByIdAndUpdate\(\n?\s*(.+?),\n?\s*\{(.*?)\}/g, (match, entityPrefix, id, args) => {
   return `await this.${entityPrefix}Repo.update(${id}, {${args}}`; // This is rough but let"s see
});


// .exec()
content = content.replace(/\.exec\(\)/g, "");

// Sort
content = content.replace(/\.sort\(\{(.*?)\}\)/g, "");

fs.writeFileSync(servicePath, content);
console.log("Regex rewrite completed. Now checking specific cases...");

