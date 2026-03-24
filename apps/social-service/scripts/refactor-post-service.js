
const fs = require("fs");
const path = require("path");

const servicePath = path.join(__dirname, "../src/posts/posts.service.ts");
let content = `import { Injectable, NotFoundException, BadRequestException, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { HttpService } from "@nestjs/axios";
import { ConfigService } from "@nestjs/config";
import { lastValueFrom } from "rxjs";
import { Post } from "./entities/post.entity";
import * as cheerio from "cheerio";
import { URL } from "url";

@Injectable()
export class PostsService {
  private readonly logger = new Logger(PostsService.name);

  constructor(
    @InjectRepository(Post) private readonly postRepo: Repository<Post>,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService
  ) {}

  async create(data: any) {
    const post = this.postRepo.create(data);
    return this.postRepo.save(post);
  }

  async listTokens(limit = 20) {
    return this.postRepo.find({
      order: { createdAt: "DESC" },
      take: Number(limit)
    });
  }

  async listMentions(userId: string, limit = 20) {
    const post = await this.postRepo
      .createQueryBuilder("post")
      .where("post.mentions LIKE :userId", { userId: \`%\${userId}%\` })
      .orderBy("post.createdAt", "DESC")
      .take(Number(limit))
      .getMany();
    return post;
  }

  async getById(id: string) {
    return this.postRepo.findOne({ where: { id } });
  }

  async setLinks(id: string, data: any) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) throw new NotFoundException();
    post.links = [...(post.links || []), ...data.links];
    return this.postRepo.save(post);
  }

  async setImages(id: string, data: any) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) throw new NotFoundException();
    post.images = [...(post.images || []), ...data.images];
    return this.postRepo.save(post);
  }

  async setForm(id: string, formId: string) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) throw new NotFoundException();
    post.attachedFormId = formId;
    return this.postRepo.save(post);
  }

  async parsePostLinks(id: string) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) throw new NotFoundException();

    const urlRegex = /(https?:\\/\\/[^\\s]+)/g;
    const urls = post.markdown?.match(urlRegex) || [];
    if (!urls.length) return post;

    const newLinks: any[] = [];
    for (const url of urls) {
       if (post.links?.some((l: any) => l.url === url)) continue;
       try {
         const meta = await this.fetchUrlMeta(url);
         if (meta) {
           newLinks.push({
             url,
             title: meta.title || url,
             description: meta.description,
             imageUrl: meta.image
           });
         }
       } catch (e) {
         this.logger.error(\`Failed to parse URL: \${url}\`, e);
       }
    }
    
    if (newLinks.length > 0) {
      post.links = [...(post.links || []), ...newLinks];
      return this.postRepo.save(post);
    }

    return post;
  }

  private async fetchUrlMeta(url: string) {
     try {
       const resp = await lastValueFrom(this.httpService.get(url, {
         timeout: 3000,
         headers: { "User-Agent": "Mozilla/5.0 (Bot)" }
       }));
       if (!resp.data) return null;

       const $ = cheerio.load(resp.data as any);
       const title = $("head title").text() || $("meta[property=\x27og:title\x27]").attr("content");
       const description = $("meta[name=\x27description\x27]").attr("content") || $("meta[property=\x27og:description\x27]").attr("content");
       const image = $("meta[property=\x27og:image\x27]").attr("content");

       return { title, description, image };
     } catch (e) {
       return null;
     }
  }

  async notifyMentions(id: string) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post || !post.mentions?.length) return post;
    
    // Check communication inter-service pour envoyer notifications ou emails
    // A refactorer plus tard.
    this.logger.log(\`Notifying mentions for post \${id}: \${post.mentions.join(",")}\`);
    return post;
  }

  async addPoll(id: string, question: string, options: string[]) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) throw new NotFoundException();

    const poll = {
      id: Math.random().toString(36).substring(2, 10),
      question,
      options: options.map(opt => ({
         id: Math.random().toString(36).substring(2, 10),
         text: opt,
         votes: []
      }))
    };

    post.polls = [...(post.polls || []), poll];
    return this.postRepo.save(post);
  }

  async votePoll(pollId: string, optionId: string, userId: string) {
     // Avec JSONB dans Postgres, on a besoin du jsonb_set ou de manipuler en memoire. 
     // Pour simplifier on chosit le post, on modifie, et on remet.
     // Pour trouver le post by pollId en JSONB Array on utilise une requete raw
     const post = await this.postRepo.createQueryBuilder("post")
       .where("post.polls::jsonb @> :poll", { poll: [{ id: pollId }] })
       .getOne();
     
     if (!post) throw new NotFoundException("Poll not found");

     let updated = false;
     for (const p of post.polls || []) {
       if (p.id === pollId) {
         // remove user from all existing options just in case
         for (const opt of p.options) {
            opt.votes = (opt.votes || []).filter((v: string) => v !== userId);
         }
         // add to chosen option
         const targetOpt = p.options.find((o: any) => o.id === optionId);
         if (targetOpt) {
            targetOpt.votes.push(userId);
            updated = true;
         }
       }
     }

     if (updated) {
       return this.postRepo.save(post);
     }
     return post;
  }

  async addEventButton(id: string, text: string, eventPayload: any) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) throw new NotFoundException();
    
    const btn = {
       id: Math.random().toString(36).substring(2, 10),
       text,
       eventPayload,
       clickCount: 0
    };

    post.eventButtons = [...(post.eventButtons || []), btn];
    return this.postRepo.save(post);
  }

  async delete(id: string) {
    await this.postRepo.delete(id);
    return { success: true };
  }
}
`;

fs.writeFileSync(servicePath, content);
console.log("Rewrite posts.service.ts completed.");

