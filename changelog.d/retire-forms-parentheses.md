### Fixed - forms: deleting an association or a form works again

Both failed since `1.2.4`: the SQL that archives or removes a form was missing parentheses, a syntax error no unit test saw. A PostgreSQL test now runs it ([forms](docs/wiki/frontend/modules/forms.md)).
