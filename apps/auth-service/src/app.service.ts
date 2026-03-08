import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AppService {
  constructor(private readonly jwtService: JwtService) {}

  generateToken(userId: string): { token: string } {
    const token = this.jwtService.sign({ sub: userId });
    return { token };
  }
}
