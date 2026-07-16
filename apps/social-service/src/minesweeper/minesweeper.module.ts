import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MinesweeperChallenge } from './entities/minesweeper-challenge.entity';
import { MinesweeperScore } from './entities/minesweeper-score.entity';
import { MinesweeperController } from './minesweeper.controller';
import { MinesweeperService } from './minesweeper.service';

/** Ranked Minesweeper challenges, verified scores, and leaderboard. */
@Module({
  imports: [TypeOrmModule.forFeature([MinesweeperChallenge, MinesweeperScore])],
  controllers: [MinesweeperController],
  providers: [MinesweeperService],
})
export class MinesweeperModule {}
