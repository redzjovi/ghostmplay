import { IsString, Matches, MaxLength, MinLength } from 'class-validator'

/** Lowercase ASCII so login is unambiguous and the citext column never surprises us. */
const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/

export class RegisterDto {
  @IsString()
  @Matches(USERNAME_RE, {
    message: 'username must be 3-32 characters: lowercase letters, digits, dot, dash or underscore',
  })
  username!: string

  @IsString()
  @MinLength(8, { message: 'password must be at least 8 characters' })
  @MaxLength(200, { message: 'password must be at most 200 characters' })
  password!: string
}

export class LoginDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  username!: string

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password!: string
}
