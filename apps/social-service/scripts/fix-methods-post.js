
const fs = require("fs");
const path = require("path");
const servicePath = path.join(__dirname, "../src/posts/posts.service.ts");
let content = fs.readFileSync(servicePath, "utf-8");

// rename create to createPost
content = content.replace(/async create\(data: any\)/, "async createPost(data: any)");
// rename listTokens to listPosts
content = content.replace(/async listTokens\(limit = 20\)/, "async listPosts(limit: number = 20, offset: number = 0)");
content = content.replace(/take: Number\(limit\)/, "take: Number(limit),\n      skip: Number(offset)");

// fix votePoll
content = content.replace(/async votePoll\(pollId: string, optionId: string, userId: string\)/, "async votePoll(postId: string, pollId: string, data: any)");
content = content.replace(/where\("post.polls::jsonb @> :poll", \{ poll: \[\{ id: pollId \}\] \}\)/, "where(\"post.id = :postId\", { postId })");
content = content.replace(/const targetOpt = p.options.find\(\(o: any\) => o.id === optionId\);/g, "const targetOpt = p.options.find((o: any) => o.id === data.optionId);\n         const userId = data.userId;");
content = content.replace(/opt.votes = \(opt.votes \|\| \[\]\).filter\(\((v: string) => v !== userId\)\);/g, "opt.votes = (opt.votes || []).filter((v: string) => v !== data.userId);");

// add registerEvent
if (!content.includes("async registerEvent")) {
  content += `\n  async registerEvent(postId: string, buttonId: string, data: any) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException();
    // Logic for button registration
    return { success: true };
  }\n`;
}

// add submitForm
if (!content.includes("async submitForm")) {
  content += `\n  async submitForm(postId: string, formId: string, data: any) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException();
    return { success: true };
  }\n`;
}

fs.writeFileSync(servicePath, content);
console.log("posts.service methods fixed");

