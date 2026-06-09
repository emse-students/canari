import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class AvatarService {
  private readonly logger = new Logger(AvatarService.name);
  private readonly avatarApiUrl: string;
  private readonly avatarApiKey: string;

  constructor(private readonly configService: ConfigService) {
    this.avatarApiUrl = this.configService.get<string>(
      'MIGALLERY_API_URL',
      'https://gallery.mitv.fr',
    );
    this.avatarApiKey = this.configService.get<string>('MIGALLERY_API_KEY', '');

    if (!this.avatarApiKey) {
      this.logger.warn(
        'MIGALLERY_API_KEY is not set — avatar proxy will not work.',
      );
    }
  }

  /**
   * Fetch user avatar from external API
   * @param userId User ID
   * @returns Avatar image buffer
   */
  async fetchUserAvatar(userId: string): Promise<Buffer> {
    if (!this.avatarApiKey) {
      throw new HttpException(
        'Avatar service is not configured',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    // Prevent SSRF / path traversal: userId must be a safe alphanumeric identifier.
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(userId)) {
      throw new HttpException('Invalid user ID', HttpStatus.BAD_REQUEST);
    }

    try {
      const url = `${this.avatarApiUrl}/api/users/${userId}/avatar`;

      const response = await axios.get(url, {
        headers: {
          'x-api-key': this.avatarApiKey,
        },
        responseType: 'arraybuffer',
        timeout: 5000,
        // Disable redirects: following them to unknown destinations is a SSRF vector.
        maxRedirects: 0,
      });

      return Buffer.from(response.data);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 404) {
          throw new HttpException('Avatar not found', HttpStatus.NOT_FOUND);
        }
        if (error.response?.status === 401 || error.response?.status === 403) {
          throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
        }
        if (error.code === 'ECONNABORTED') {
          throw new HttpException(
            'Request timeout',
            HttpStatus.GATEWAY_TIMEOUT,
          );
        }
      }

      this.logger.error('Error fetching avatar', error);
      throw new HttpException(
        'Failed to fetch avatar from external service',
        HttpStatus.BAD_GATEWAY,
      );
    }
  }
}
