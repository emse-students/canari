import { Injectable, PipeTransform } from '@nestjs/common';

function isPlainObject(value: any): value is Record<string, any> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

export function sanitizeMongoObject<T>(input: T): T {
  if (input == null) return input;
  if (Array.isArray(input)) return input.map((v) => sanitizeMongoObject(v)) as unknown as T;
  if (!isPlainObject(input)) return input;

  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(input as Record<string, any>)) {
    if (k.startsWith('$')) continue;
    if (k.includes('.')) continue;

    if (Array.isArray(v)) {
      out[k] = v.map((item) => sanitizeMongoObject(item));
    } else if (isPlainObject(v)) {
      out[k] = sanitizeMongoObject(v);
    } else {
      out[k] = v;
    }
  }

  return out as unknown as T;
}

@Injectable()
export class SanitizeMongoPipe implements PipeTransform {
  transform(value: any) {
    try {
      return sanitizeMongoObject(value);
    } catch (err) {
      return value;
    }
  }
}

export default SanitizeMongoPipe;
