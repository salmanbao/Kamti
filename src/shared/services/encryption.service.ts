import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class EncryptionService {
  private readonly algorithm = 'aes-256-gcm';
  private readonly key: Buffer;
  private readonly nonceLength = 12;

  constructor(private readonly configService: ConfigService) {
    const encryptionKey = this.configService.get('ENCRYPTION_KEY') as string;
    if (!encryptionKey || typeof encryptionKey !== 'string') {
      throw new Error(
        'ENCRYPTION_KEY must be a non-empty string set in environment variables',
      );
    }
    // Derive a 32-byte key securely using PBKDF2 (better than plain hash for password-like keys)
    const salt = this.configService.get('ENCRYPTION_SALT') as string;
    this.key = crypto.pbkdf2Sync(
      encryptionKey,
      salt,
      100000, // High iterations for security (slows brute-force)
      32, // 32 bytes for AES-256
      'sha256',
    );
  }

  encrypt(text: string): string {
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('Input text must be a non-empty string');
    }

    const nonce = crypto.randomBytes(this.nonceLength);
    const cipher = crypto.createCipheriv(this.algorithm, this.key, nonce);
    const encrypted = Buffer.concat([
      cipher.update(text, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    const encryptedText = [
      nonce.toString('hex'),
      encrypted.toString('hex'),
      tag.toString('hex'),
    ].join(':');

    return Buffer.from(encryptedText).toString('base64');
  }

  decrypt(encryptedText: string): string {
    encryptedText = Buffer.from(encryptedText, 'base64').toString('utf8');

    if (typeof encryptedText !== 'string' || encryptedText.length === 0) {
      throw new Error('Encrypted text must be a non-empty string');
    }

    const parts = encryptedText.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted text format');
    }

    const [nonceHex, encryptedHex, tagHex] = parts;
    if (!nonceHex || !encryptedHex || !tagHex) {
      throw new Error('Missing components in encrypted text');
    }

    let nonce: Buffer;
    let encrypted: Buffer;
    let tag: Buffer;
    try {
      nonce = Buffer.from(nonceHex, 'hex');
      encrypted = Buffer.from(encryptedHex, 'hex');
      tag = Buffer.from(tagHex, 'hex');
    } catch (error) {
      throw new Error('Invalid hex encoding in encrypted text');
    }

    if (nonce.length !== this.nonceLength) {
      throw new Error('Invalid nonce length');
    }
    if (tag.length !== 16) {
      // GCM tag is 16 bytes
      throw new Error('Invalid authentication tag');
    }

    let decipher: crypto.DecipherGCM;
    try {
      decipher = crypto.createDecipheriv(this.algorithm, this.key, nonce);
      decipher.setAuthTag(tag);
    } catch (error) {
      throw new Error('Failed to initialize decryption');
    }

    let decrypted: Buffer;
    try {
      const decryptedPart = decipher.update(encrypted);
      const finalPart = decipher.final();
      decrypted = Buffer.concat([decryptedPart, finalPart]);
    } catch (error) {
      throw new Error(
        'Decryption failed: Invalid authentication tag or corrupted data',
      );
    }

    const result = decrypted.toString('utf8');
    if (result.length === 0) {
      throw new Error('Decrypted text is empty');
    }
    return result;
  }
}
