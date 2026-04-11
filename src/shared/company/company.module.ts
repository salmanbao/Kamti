import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CompanyService } from './company.service';
import { Company, CompanySchema } from './schemas/company.schema';
import { CompanyController } from './company.controller';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeatureAsync([
      {
        name: Company.name,
        useFactory: (configService: ConfigService) => {
          const schema = CompanySchema;
          const encryptionKey = configService.get<string>('ENCRYPTION_KEY');
          const signingKey = configService.get<string>('ENCRYPTION_SALT');

          if (!encryptionKey || !signingKey) {
            throw new Error('ENCRYPTION_KEY and ENCRYPTION_SALT are missing');
          }

          const mongooseEncryption = require('mongoose-encryption');
          schema.plugin(mongooseEncryption, {
            encryptionKey,
            signingKey,
            encryptedFields: ['secret'],
          });

          return schema;
        },
        inject: [ConfigService],
      },
    ]),
  ],
  controllers: [CompanyController],
  providers: [CompanyService],
  exports: [CompanyService],
})
export class CompanyModule {}
