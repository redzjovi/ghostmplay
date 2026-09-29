import { ParseIntPipe } from '@nestjs/common'

/**
 * Path params always arrive as strings; a non-numeric token id is a client bug,
 * so surface it as a 400 rather than letting it reach the query layer as `NaN`.
 */
export const TokenIdParam = new ParseIntPipe({ errorHttpStatusCode: 400 })
