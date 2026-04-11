import { Controller, Get, Inject, Query } from '@nestjs/common';
import { AppService } from './app.service';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import { AmlEnviornment } from '@aml/types/aml';

@Controller()
@ApiTags('Health')
export class AppController {
  constructor(
    private readonly appService: AppService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health')
  @ApiOperation({ summary: 'Health check endpoint' })
  getHealth(): { status: string; timestamp: string } {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('/aml/toggle')
  async toggleAml(
    @Query('score') score: number | undefined,
    @Query('environment') environment: AmlEnviornment | undefined,
  ): Promise<{
    score?: number | undefined;
    environment?: AmlEnviornment | undefined;
  }> {
    let myScore = score;
    let myEnv = environment;

    if (myScore === undefined) {
      myScore = (await this.cacheManager.get('aml-score')) || 90;
    } else {
      await this.cacheManager.set('aml-score', myScore);
    }

    if (myEnv === undefined) {
      myEnv = (await this.cacheManager.get('aml-environment')) || 'production';
    } else {
      await this.cacheManager.set('aml-environment', myEnv);
    }

    return {
      ...(myScore !== undefined ? { score: Number(myScore) } : {}),
      ...(myEnv !== undefined ? { environment: myEnv } : {}),
    };
  }
}
