import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  // Executa migrations automaticamente na subida se AUTO_MIGRATE != false
  if (process.env.AUTO_MIGRATE !== "false") {
    const orm = app.get(MikroORM);
    await orm.getMigrator().up();
  }

  // Habilita Graceful Shutdown para capturar SIGTERM / SIGINT (Seção 10)
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
}

bootstrap();
