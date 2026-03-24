
const fs = require("fs");
const path = require("path");

const servicePath = path.join(__dirname, "../src/channels/channel.service.ts");
let content = fs.readFileSync(servicePath, "utf-8");

// DTO adjustments
// createWorkspace
content = content.replace(/name: input.name,\n\s*slug: input.slug,\n\s*description: input.description,\n\s*ownerId: input.ownerId,\n\s*metadata: input.metadata \|\| \{\},/g, 
`name: input.name,\n      slug: input.slug,\n      ownerId: input.createdBy,`);
content = content.replace(/userId: input.ownerId,/g, `userId: input.createdBy,`);

// createChannel
content = content.replace(/name: input.name,\n\s*isPrivate: input.isPrivate \|\| false,\n\s*allowedRoles: input.allowedRoles \|\| \[\],/g, 
`name: input.name,\n      isPrivate: input.visibility === "private",\n      allowedRoles: [],`);

// kickMember
content = content.replace(/input.adminId/g, `input.actorUserId`);

// updateMemberRole (roleName -> roleId)
content = content.replace(/const roleIds = \[\.\.\.new Set\(\[\.\.\.\(targetMember.roleIds \|\| \[\]\), \.\.\.input.roleIds\]\)\];/g, 
`const role = await this.roleRepo.findOne({ where: { workspaceId: channel.workspaceId, name: input.roleName } }); if (!role) throw new NotFoundException("Role not found"); const roleIds = [...new Set([...(targetMember.roleIds || []), role.id])];`);

content = content.replace(/if \(input.action === "add"\) \{\n\s*targetMember.roleIds = roleIds;\n\s*\} else \{\n\s*targetMember.roleIds = targetMember.roleIds.filter\(r => !input.roleIds.includes\(r\)\);\n\s*\}/g, 
`targetMember.roleIds = roleIds;`);

// sendMessage
content = content.replace(/authorId: input.authorId,\n\s*content: input.content,\n\s*replyTo: input.replyTo,\n\s*attachments: input.attachments \|\| \[\],\n\s*metadata: input.metadata \|\| \{\},/g, 
`authorId: input.senderId,\n      content: input.ciphertext,\n      replyTo: input.nonce,\n      metadata: { keyVersion: input.keyVersion },`);

content = content.replace(/input.authorId/g, `input.senderId`);

fs.writeFileSync(servicePath, content);
console.log("Refit complete");

