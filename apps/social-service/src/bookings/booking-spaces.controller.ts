import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { BookingSpacesService } from './booking-spaces.service';
import { actorOf } from './bookings.controller';
import {
  AvailabilityDto,
  CreateResourceDto,
  CreateSpaceDto,
  ResourceDto,
  SpaceSettingsDto,
} from './dto/space.dto';

/**
 * The organiser's routes (WP-B4): spaces, resources and availability. Under the same prefix and
 * guard as the booker's routes (`BookingsController`); rights are checked in the service.
 */
@Controller('bookings')
@UseGuards(NginxAuthGuard)
export class BookingSpacesController {
  constructor(private readonly service: BookingSpacesService) {}

  /** The spaces of an entity (`associationId`), or the actor's personal ones (no parameter). */
  @Get('managed')
  managed(
    @Query('associationId', new ParseUUIDPipe({ optional: true })) associationId:
      | string
      | undefined,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    return this.service.managedList(associationId ?? null, actorOf(userId, ga));
  }

  @Post('spaces')
  create(
    @Body() dto: CreateSpaceDto,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    return this.service.create(dto, actorOf(userId, ga));
  }

  /** Every setting and every resource with its availability: the editor's read. */
  @Get('spaces/:spaceId/manage')
  manage(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    return this.service.managedSpaceView(spaceId, actorOf(userId, ga));
  }

  @Patch('spaces/:spaceId')
  update(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: SpaceSettingsDto,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    return this.service.update(spaceId, dto, actorOf(userId, ga), Date.now());
  }

  /** Deletes the space and everything under it (D27). */
  @Delete('spaces/:spaceId')
  remove(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    return this.service.remove(spaceId, actorOf(userId, ga), Date.now());
  }

  @Post('spaces/:spaceId/resources')
  addResource(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: CreateResourceDto,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    return this.service.addResource(spaceId, dto, actorOf(userId, ga));
  }

  @Patch('resources/:resourceId')
  updateResource(
    @Param('resourceId', ParseUUIDPipe) resourceId: string,
    @Body() dto: ResourceDto,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    return this.service.updateResource(resourceId, dto, actorOf(userId, ga));
  }

  /** Deletes a resource that was never booked (D42); one with history is closed instead. */
  @Delete('resources/:resourceId')
  removeResource(
    @Param('resourceId', ParseUUIDPipe) resourceId: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    return this.service.removeResource(resourceId, actorOf(userId, ga));
  }

  /** Replaces the resource's whole availability; refused over coming bookings (D29). */
  @Put('resources/:resourceId/availability')
  setAvailability(
    @Param('resourceId', ParseUUIDPipe) resourceId: string,
    @Body() dto: AvailabilityDto,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    return this.service.setAvailability(resourceId, dto, actorOf(userId, ga), Date.now());
  }
}
