import {
  Injectable,
  Logger,
  NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { CompanyService } from '@shared/company/company.service';

@Injectable()
export class ApiKeyAuthMiddleware implements NestMiddleware {
  private readonly logger = new Logger(ApiKeyAuthMiddleware.name);

  constructor(private readonly companyService: CompanyService) {}

  async use(req: Request, res: Response, next: NextFunction) {
    const apiKey = req.headers['x-api-key'] as string;

    if (!apiKey) {
      this.logger.error('API key is missing');
      throw new UnauthorizedException('API key is missing');
    }

    const company = await this.companyService.findByApiKey(apiKey);

    if (!company) {
      this.logger.error('Invalid API key');
      throw new UnauthorizedException('Invalid API key');
    }

    (req as any).company = company;

    next();
  }
}
