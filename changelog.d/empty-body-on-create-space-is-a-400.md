### Fixed - creating a space or a resource with an empty body is refused with a 400

`POST /api/bookings/spaces` and `POST .../resources` with no name answered 500: the settings class's optional `name` silenced the create class's required one, so the request reached the database with no name. The name is now declared once per route, required on create.
