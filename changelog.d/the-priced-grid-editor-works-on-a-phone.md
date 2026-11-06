### Fixed - the priced-grid editor reorders on a phone, and says where the server refused it

Rows and columns now move with 44px arrow buttons on a touch screen or a phone-width page, and every small control of the grid editor reaches 44px on touch. Removing a row or column that would leave every cell closed is refused with a message, and "Plusieurs reponses" goes back off when the grid that switched it on is removed. A grid refused by the server alone (an unknown cotisation tier) is now drawn under that grid ([forms](docs/wiki/frontend/modules/forms.md#the-editor-wp-g3)).
