import { Global, Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { AccountEntity, SessionEntity } from './entities'
import { AuthService } from './auth.service'
import { SessionService } from './session.service'
import { AuthController } from './controllers/auth.controller'
import { AuthGuard, RequireAuthGuard, AdminGuard } from './guards'

/**
 * Global so every feature module can inject the guards and services without
 * re-importing TypeOrmModule for the auth tables.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AccountEntity, SessionEntity])],
  controllers: [AuthController],
  providers: [AuthService, SessionService, AuthGuard, RequireAuthGuard, AdminGuard],
  exports: [AuthService, SessionService, AuthGuard, RequireAuthGuard, AdminGuard],
})
export class AuthModule {}
