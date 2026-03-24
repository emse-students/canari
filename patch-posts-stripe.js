
const fs = require("fs");
let p = fs.readFileSync("apps/social-service/src/posts/posts.service.ts", "utf8");

// Ajouter Stripe et HttpService config si manquant
p = p.replace("private readonly configService: ConfigService\n  ) {}", "private readonly configService: ConfigService\n  ) {\n    this.userServiceUrl = this.configService.get<string>(\"USER_SERVICE_URL\", \"http://localhost:3013\");\n    const secretKey = this.configService.get<string>(\"STRIPE_SECRET_KEY\");\n    this.stripe = secretKey ? new (require(\"stripe\").default)(secretKey, { apiVersion: \"2025-08-27.basil\" }) : null;\n  }");

p = p.replace("private readonly logger = new Logger(PostsService.name);", "private readonly logger = new Logger(PostsService.name);\n  private readonly userServiceUrl: string;\n  private readonly stripe: any;");

// Update registerEvent
const registerEventRegex = /async registerEvent([^}]*)\{([^}]*)\}/;
p = p.replace(registerEventRegex, `async registerEvent(postId: string, _buttonId: string, _data: any) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException();

    // Check user service (Phase 3.7)
    try {
      const userRes = await lastValueFrom(
        this.httpService.get(\`\${this.userServiceUrl}/users/\${_data.userId}\`)
      );
      this.logger.log(\`Successfully communicated with user-service for user \${_data.userId}\`);
    } catch (err: any) {
      this.logger.error(\`Failed inter-service communication with user-service for \${_data.userId}: \${err.message}\`);
    }

    return { success: true };
}`);

const submitFormRegex = /async submitForm\([^}]*\)\s*\{[^}]*\}/;
p = p.replace(submitFormRegex, `async submitForm(postId: string, _formId: string, _data: any) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException();

    // Check user service (Phase 3.7)
    try {
      const userRes = await lastValueFrom(
        this.httpService.get(\`\${this.userServiceUrl}/users/\${_data.userId}\`)
      );
      this.logger.log(\`Successfully communicated with user-service for user \${_data.userId}\`);
    } catch (err: any) {
      this.logger.error(\`Failed inter-service communication with user-service for \${_data.userId}: \${err.message}\`);
    }

    return { success: true };
}`);

fs.writeFileSync("apps/social-service/src/posts/posts.service.ts", p);

