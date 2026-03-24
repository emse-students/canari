
const fs = require("fs");
const path = require("path");

const servicePath = path.join(__dirname, "../src/channels/channel.service.ts");
let content = fs.readFileSync(servicePath, "utf-8");

// Fix _id and $in
content = content.replace(/_id:/g, "id:");
content = content.replace(/\{ \$in: (.*?) \}/g, "In($1)");
content = content.replace(/_id\.toString\(\)/g, "id");
content = content.replace(/\.id\.toString\(\)/g, ".id");
content = content.replace(/ \._id/g, " .id");

// Fix update findByIdAndUpdate regex errors
// findByIdAndUpdate( id, { $set: { name, description } }, { new: true } )
content = content.replace(/await this\.([a-zA-Z]+)Repo\.update\s*\(\s*(.+?),\s*\{\s*\$set:\s*\{(.*?)\}\s*\}\s*,\s*\{\s*new:\s*true\s*\}\s*\)/g, 
  (match, repo, id, args) => {
     return `await this.${repo}Repo.update({ id: ${id} }, { ${args} }); return this.${repo}Repo.findOne({ where: { id: ${id} } })`;
  }
);
content = content.replace(/await this\.workspaceRepo\.update\s*\(id,\s*\{\s*\$set:\s*\{\s*name,\s*description\s*\}\s*\}\s*,\s*\{\s*new:\s*true\s*\}\s*\)/g, 
`await this.workspaceRepo.update(id, { name, description });\n    return this.workspaceRepo.findOne({ where: { id } });`);

// channel roles updates:
// await this.roleRepo.update( roleId, { $set: { name, permissions } }, { new: true } );
content = content.replace(/await this\.roleRepo\.update\(\s*roleId,\s*\{\s*\$set:\s*\{([^}]+)\}\s*\}\s*,\s*\{\s*new:\s*true\s*\}\s*\)/g,
`await this.roleRepo.update(roleId, {$1});\n    return this.roleRepo.findOne({ where: { id: roleId } })`);

content = content.replace(/await this\.roleRepo\.update\(\s*roleId,\s*\{\s*\$set:\s*\{([^}]+)\}\s*\}\s*\)/g,
`await this.roleRepo.update(roleId, {$1})`);

// Find with pagination in getChannelMessages
// this.messageRepo.find({ where: {channelId} })      .limit(Number(limit))
content = content.replace(/this\.messageRepo\.find\(\{ where: \{channelId\} \}\)(?:\s*\.limit\(Number\(limit\)\))?/g, 
`this.messageRepo.find({ where: { channelId }, order: { createdAt: "DESC" }, take: Number(limit) })`);

content = content.replace(/\.limit\(Number\(limit\)\)/g, "");

content = content.replace(/this\.channelRepo\.findOne\(\{ where: \{ workspaceId,\n      name: .general., \} \}\)/g, `this.channelRepo.findOne({ where: { workspaceId, name: "general" } })`);

// findAndDelete / deleteOne
content = content.replace(/await this\.([a-zA-Z]+)Model\.findByIdAndDelete\((.+?)\)/g, `await this.$1Repo.delete($2)`);
content = content.replace(/await this\.([a-zA-Z]+)Model\.deleteMany\(\{(.+?)\}\)/g, `await this.$1Repo.delete({ $2 })`);
content = content.replace(/await this\.([a-zA-Z]+)Model\.deleteOne\(\{(.+?)\}\)/g, `await this.$1Repo.delete({ $2 })`);


// Fix the remaining "Model.something"
content = content.replace(/this\.workspaceModel/g, "this.workspaceRepo");
content = content.replace(/this\.channelModel/g, "this.channelRepo");
content = content.replace(/this\.roleModel/g, "this.roleRepo");
content = content.replace(/this\.memberModel/g, "this.memberRepo");
content = content.replace(/this\.messageModel/g, "this.messageRepo");

// Save object
content = content.replace(/await newRole\.save\(\)/g, `await this.roleRepo.save(newRole)`);
content = content.replace(/const newRole = new this\.roleRepo\((.*?)\)/g, `const newRole = this.roleRepo.create($1)`);

// Member create
content = content.replace(/const adminMember = new this\.memberRepo\((.*?)\);\n\s*await adminMember\.save\(\);/g, `const adminMember = this.memberRepo.create($1);\n    await this.memberRepo.save(adminMember);`);
content = content.replace(/const memberRole = new this\.roleRepo\((.*?)\);\n\s*await memberRole\.save\(\);/g, `const memberRole = this.roleRepo.create($1);\n    await this.roleRepo.save(memberRole);`);

content = content.replace(/const newMember = new this\.memberRepo\((.*?)\);\n\s*await newMember\.save\(\);/g, `const newMember = this.memberRepo.create($1);\n    await this.memberRepo.save(newMember);`);


// Fix $push in update roles for channel
content = content.replace(/await this\.channelRepo\.update\(\n      channelId,\n      \{ \$push: \{ allowedRoles: roleId \} \}\n    \)/g, `const ch = await this.channelRepo.findOne({where:{id: channelId}}); if (ch) { ch.allowedRoles = [...(ch.allowedRoles || []), roleId]; await this.channelRepo.save(ch); }`);
content = content.replace(/await this\.channelRepo\.update\(\n      channelId,\n      \{ \$pull: \{ allowedRoles: roleId \} \}\n    \)/g, `const ch = await this.channelRepo.findOne({where:{id: channelId}}); if (ch && ch.allowedRoles) { ch.allowedRoles = ch.allowedRoles.filter(r => r !== roleId); await this.channelRepo.save(ch); }`);

// general channel roles replacement
content = content.replace(/new this\.([a-zA-Z]+)Repo\((.*?)\)/g, `this.$1Repo.create($2)`);
content = content.replace(/\.save\(\)/g, ""); // strip random .save(), wait I already replaced adminMember.save

fs.writeFileSync(servicePath, content);
console.log("Refactored channel service syntax");

