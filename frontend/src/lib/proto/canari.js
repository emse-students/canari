/*eslint-disable block-scoped-var, id-length, no-control-regex, no-magic-numbers, no-mixed-operators, no-prototype-builtins, no-redeclare, no-shadow, no-var, sort-vars, default-case, jsdoc/require-param*/
import $protobuf from "protobufjs/minimal.js";

// Common aliases
const $Reader = $protobuf.Reader, $Writer = $protobuf.Writer, $util = $protobuf.util;
const $Object = $util.global.Object, $undefined = $util.global.undefined, $Error = $util.global.Error, $TypeError = $util.global.TypeError, $String = $util.global.String, $Array = $util.global.Array, $Boolean = $util.global.Boolean, $Number = $util.global.Number, $parseInt = $util.global.parseInt, $BigInt = $util.global.BigInt;

// Exported root namespace
const $root = $protobuf.roots["default"] || ($protobuf.roots["default"] = {});

export const canari = $root.canari = (() => {

    /**
     * Namespace canari.
     * @exports canari
     * @namespace
     */
    const canari = {};

    canari.WsEnvelope = (function() {

        /**
         * Properties of a WsEnvelope.
         * @typedef {Object} canari.WsEnvelope.$Properties
         * @property {canari.MlsFrame.$Properties|null} [mls] WsEnvelope mls
         * @property {canari.WelcomeFrame.$Properties|null} [welcome] WsEnvelope welcome
         * @property {canari.ReadAck.$Properties|null} [read] WsEnvelope read
         * @property {"mls"|"welcome"|"read"} [body] WsEnvelope body
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of a WsEnvelope.
         * @memberof canari
         * @interface IWsEnvelope
         * @augments canari.WsEnvelope.$Properties
         * @deprecated Use canari.WsEnvelope.$Properties instead.
         */

        /**
         * Narrowed shape of a WsEnvelope.
         * @typedef {{
         *   mls?: canari.MlsFrame.$Shape|null;
         *   welcome?: canari.WelcomeFrame.$Shape|null;
         *   read?: canari.ReadAck.$Shape|null;
         *   $unknowns?: Array.<Uint8Array>;
         * } & (
         *   ({ body?: undefined; mls?: null; welcome?: null; read?: null }|{ body?: "mls"; mls: canari.MlsFrame.$Shape; welcome?: null; read?: null }|{ body?: "welcome"; mls?: null; welcome: canari.WelcomeFrame.$Shape; read?: null }|{ body?: "read"; mls?: null; welcome?: null; read: canari.ReadAck.$Shape })
         * )} canari.WsEnvelope.$Shape
         */

        /**
         * Constructs a new WsEnvelope.
         * @memberof canari
         * @classdesc Represents a WsEnvelope.
         * @constructor
         * @param {canari.WsEnvelope.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        const WsEnvelope = function (properties) {
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        /**
         * WsEnvelope mls.
         * @member {canari.MlsFrame.$Properties|null|undefined} mls
         * @memberof canari.WsEnvelope
         * @instance
         */
        WsEnvelope.prototype.mls = null;

        /**
         * WsEnvelope welcome.
         * @member {canari.WelcomeFrame.$Properties|null|undefined} welcome
         * @memberof canari.WsEnvelope
         * @instance
         */
        WsEnvelope.prototype.welcome = null;

        /**
         * WsEnvelope read.
         * @member {canari.ReadAck.$Properties|null|undefined} read
         * @memberof canari.WsEnvelope
         * @instance
         */
        WsEnvelope.prototype.read = null;

        // OneOf field names bound to virtual getters and setters
        let $oneOfFields;

        /**
         * WsEnvelope body.
         * @member {"mls"|"welcome"|"read"|undefined} body
         * @memberof canari.WsEnvelope
         * @instance
         */
        $Object.defineProperty(WsEnvelope.prototype, "body", {
            get: $util.oneOfGetter($oneOfFields = ["mls", "welcome", "read"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        /**
         * Creates a new WsEnvelope instance using the specified properties.
         * @function create
         * @memberof canari.WsEnvelope
         * @static
         * @param {canari.WsEnvelope.$Properties=} [properties] Properties to set
         * @returns {canari.WsEnvelope} WsEnvelope instance
         * @type {{
         *   (properties: canari.WsEnvelope.$Shape): canari.WsEnvelope & canari.WsEnvelope.$Shape;
         *   (properties?: canari.WsEnvelope.$Properties): canari.WsEnvelope;
         * }}
         */
        WsEnvelope.create = function(properties) {
            return new WsEnvelope(properties);
        };

        /**
         * Encodes the specified WsEnvelope message. Does not implicitly {@link canari.WsEnvelope.verify|verify} messages.
         * @function encode
         * @memberof canari.WsEnvelope
         * @static
         * @param {canari.WsEnvelope.$Properties} message WsEnvelope message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        WsEnvelope.encode = function (message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            if (message.mls != null && $Object.hasOwnProperty.call(message, "mls"))
                $root.canari.MlsFrame.encode(message.mls, writer.uint32(/* id 1, wireType 2 =*/10).fork(), _depth + 1).ldelim();
            if (message.welcome != null && $Object.hasOwnProperty.call(message, "welcome"))
                $root.canari.WelcomeFrame.encode(message.welcome, writer.uint32(/* id 2, wireType 2 =*/18).fork(), _depth + 1).ldelim();
            if (message.read != null && $Object.hasOwnProperty.call(message, "read"))
                $root.canari.ReadAck.encode(message.read, writer.uint32(/* id 3, wireType 2 =*/26).fork(), _depth + 1).ldelim();
            if (message.$unknowns != null && $Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified WsEnvelope message, length delimited. Does not implicitly {@link canari.WsEnvelope.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.WsEnvelope
         * @static
         * @param {canari.WsEnvelope.$Properties} message WsEnvelope message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        WsEnvelope.encodeDelimited = function(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes a WsEnvelope message from the specified reader or buffer.
         * @function decode
         * @memberof canari.WsEnvelope
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.WsEnvelope & canari.WsEnvelope.$Shape} WsEnvelope
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        WsEnvelope.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end = length === $undefined ? reader.len : reader.pos + length, message = _target || new $root.canari.WsEnvelope();
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        message.mls = $root.canari.MlsFrame.decode(reader, reader.uint32(), $undefined, _depth + 1, message.mls);
                        message.body = "mls";
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        message.welcome = $root.canari.WelcomeFrame.decode(reader, reader.uint32(), $undefined, _depth + 1, message.welcome);
                        message.body = "welcome";
                        continue;
                    }
                case 3: {
                        if (wireType !== 2)
                            break;
                        message.read = $root.canari.ReadAck.decode(reader, reader.uint32(), $undefined, _depth + 1, message.read);
                        message.body = "read";
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            return message;
        };

        /**
         * Decodes a WsEnvelope message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.WsEnvelope
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.WsEnvelope & canari.WsEnvelope.$Shape} WsEnvelope
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        WsEnvelope.decodeDelimited = function(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a WsEnvelope message.
         * @function verify
         * @memberof canari.WsEnvelope
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        WsEnvelope.verify = function (message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            let properties = {};
            if (message.mls != null && $Object.hasOwnProperty.call(message, "mls")) {
                properties.body = 1;
                {
                    let error = $root.canari.MlsFrame.verify(message.mls, _depth + 1);
                    if (error)
                        return "mls." + error;
                }
            }
            if (message.welcome != null && $Object.hasOwnProperty.call(message, "welcome")) {
                if (properties.body === 1)
                    return "body: multiple values";
                properties.body = 1;
                {
                    let error = $root.canari.WelcomeFrame.verify(message.welcome, _depth + 1);
                    if (error)
                        return "welcome." + error;
                }
            }
            if (message.read != null && $Object.hasOwnProperty.call(message, "read")) {
                if (properties.body === 1)
                    return "body: multiple values";
                properties.body = 1;
                {
                    let error = $root.canari.ReadAck.verify(message.read, _depth + 1);
                    if (error)
                        return "read." + error;
                }
            }
            return null;
        };

        /**
         * Creates a WsEnvelope message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof canari.WsEnvelope
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {canari.WsEnvelope} WsEnvelope
         */
        WsEnvelope.fromObject = function (object, _depth) {
            if (object instanceof $root.canari.WsEnvelope)
                return object;
            if (!$util.isObject(object))
                throw $TypeError(".canari.WsEnvelope: object expected");
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let message = new $root.canari.WsEnvelope();
            if (object.mls != null) {
                if (!$util.isObject(object.mls))
                    throw $TypeError(".canari.WsEnvelope.mls: object expected");
                message.mls = $root.canari.MlsFrame.fromObject(object.mls, _depth + 1);
            }
            if (object.welcome != null) {
                if (!$util.isObject(object.welcome))
                    throw $TypeError(".canari.WsEnvelope.welcome: object expected");
                message.welcome = $root.canari.WelcomeFrame.fromObject(object.welcome, _depth + 1);
            }
            if (object.read != null) {
                if (!$util.isObject(object.read))
                    throw $TypeError(".canari.WsEnvelope.read: object expected");
                message.read = $root.canari.ReadAck.fromObject(object.read, _depth + 1);
            }
            return message;
        };

        /**
         * Creates a plain object from a WsEnvelope message. Also converts values to other types if specified.
         * @function toObject
         * @memberof canari.WsEnvelope
         * @static
         * @param {canari.WsEnvelope} message WsEnvelope
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        WsEnvelope.toObject = function (message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let object = {};
            if (message.mls != null && $Object.hasOwnProperty.call(message, "mls")) {
                object.mls = $root.canari.MlsFrame.toObject(message.mls, options, _depth + 1);
                if (options.oneofs)
                    object.body = "mls";
            }
            if (message.welcome != null && $Object.hasOwnProperty.call(message, "welcome")) {
                object.welcome = $root.canari.WelcomeFrame.toObject(message.welcome, options, _depth + 1);
                if (options.oneofs)
                    object.body = "welcome";
            }
            if (message.read != null && $Object.hasOwnProperty.call(message, "read")) {
                object.read = $root.canari.ReadAck.toObject(message.read, options, _depth + 1);
                if (options.oneofs)
                    object.body = "read";
            }
            return object;
        };

        /**
         * Converts this WsEnvelope to JSON.
         * @function toJSON
         * @memberof canari.WsEnvelope
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        WsEnvelope.prototype.toJSON = function() {
            return WsEnvelope.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for WsEnvelope
         * @function getTypeUrl
         * @memberof canari.WsEnvelope
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        WsEnvelope.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/canari.WsEnvelope";
        };

        var C = WsEnvelope;

        return WsEnvelope;
    })();

    canari.Recipient = (function() {

        /**
         * Properties of a Recipient.
         * @typedef {Object} canari.Recipient.$Properties
         * @property {string|null} [userId] Recipient userId
         * @property {string|null} [deviceId] Recipient deviceId
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of a Recipient.
         * @memberof canari
         * @interface IRecipient
         * @augments canari.Recipient.$Properties
         * @deprecated Use canari.Recipient.$Properties instead.
         */

        /**
         * Shape of a Recipient.
         * @typedef {canari.Recipient.$Properties} canari.Recipient.$Shape
         */

        /**
         * Constructs a new Recipient.
         * @memberof canari
         * @classdesc Represents a Recipient.
         * @constructor
         * @param {canari.Recipient.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        const Recipient = function (properties) {
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        /**
         * Recipient userId.
         * @member {string} userId
         * @memberof canari.Recipient
         * @instance
         */
        Recipient.prototype.userId = "";

        /**
         * Recipient deviceId.
         * @member {string} deviceId
         * @memberof canari.Recipient
         * @instance
         */
        Recipient.prototype.deviceId = "";

        /**
         * Creates a new Recipient instance using the specified properties.
         * @function create
         * @memberof canari.Recipient
         * @static
         * @param {canari.Recipient.$Properties=} [properties] Properties to set
         * @returns {canari.Recipient} Recipient instance
         * @type {{
         *   (properties: canari.Recipient.$Shape): canari.Recipient & canari.Recipient.$Shape;
         *   (properties?: canari.Recipient.$Properties): canari.Recipient;
         * }}
         */
        Recipient.create = function(properties) {
            return new Recipient(properties);
        };

        /**
         * Encodes the specified Recipient message. Does not implicitly {@link canari.Recipient.verify|verify} messages.
         * @function encode
         * @memberof canari.Recipient
         * @static
         * @param {canari.Recipient.$Properties} message Recipient message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Recipient.encode = function (message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            if (message.userId != null && $Object.hasOwnProperty.call(message, "userId"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.userId);
            if (message.deviceId != null && $Object.hasOwnProperty.call(message, "deviceId"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.deviceId);
            if (message.$unknowns != null && $Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified Recipient message, length delimited. Does not implicitly {@link canari.Recipient.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.Recipient
         * @static
         * @param {canari.Recipient.$Properties} message Recipient message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Recipient.encodeDelimited = function(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes a Recipient message from the specified reader or buffer.
         * @function decode
         * @memberof canari.Recipient
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.Recipient & canari.Recipient.$Shape} Recipient
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Recipient.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end = length === $undefined ? reader.len : reader.pos + length, message = _target || new $root.canari.Recipient(), value;
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.userId = value;
                        else
                            delete message.userId;
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.deviceId = value;
                        else
                            delete message.deviceId;
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            return message;
        };

        /**
         * Decodes a Recipient message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.Recipient
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.Recipient & canari.Recipient.$Shape} Recipient
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Recipient.decodeDelimited = function(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a Recipient message.
         * @function verify
         * @memberof canari.Recipient
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        Recipient.verify = function (message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.userId != null && $Object.hasOwnProperty.call(message, "userId"))
                if (!$util.isString(message.userId))
                    return "userId: string expected";
            if (message.deviceId != null && $Object.hasOwnProperty.call(message, "deviceId"))
                if (!$util.isString(message.deviceId))
                    return "deviceId: string expected";
            return null;
        };

        /**
         * Creates a Recipient message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof canari.Recipient
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {canari.Recipient} Recipient
         */
        Recipient.fromObject = function (object, _depth) {
            if (object instanceof $root.canari.Recipient)
                return object;
            if (!$util.isObject(object))
                throw $TypeError(".canari.Recipient: object expected");
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let message = new $root.canari.Recipient();
            if (object.userId != null)
                if (typeof object.userId !== "string" || object.userId.length)
                    message.userId = $String(object.userId);
            if (object.deviceId != null)
                if (typeof object.deviceId !== "string" || object.deviceId.length)
                    message.deviceId = $String(object.deviceId);
            return message;
        };

        /**
         * Creates a plain object from a Recipient message. Also converts values to other types if specified.
         * @function toObject
         * @memberof canari.Recipient
         * @static
         * @param {canari.Recipient} message Recipient
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        Recipient.toObject = function (message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let object = {};
            if (options.defaults) {
                object.userId = "";
                object.deviceId = "";
            }
            if (message.userId != null && $Object.hasOwnProperty.call(message, "userId"))
                object.userId = message.userId;
            if (message.deviceId != null && $Object.hasOwnProperty.call(message, "deviceId"))
                object.deviceId = message.deviceId;
            return object;
        };

        /**
         * Converts this Recipient to JSON.
         * @function toJSON
         * @memberof canari.Recipient
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        Recipient.prototype.toJSON = function() {
            return Recipient.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for Recipient
         * @function getTypeUrl
         * @memberof canari.Recipient
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        Recipient.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/canari.Recipient";
        };

        var C = Recipient;

        return Recipient;
    })();

    canari.MlsFrame = (function() {

        /**
         * Properties of a MlsFrame.
         * @typedef {Object} canari.MlsFrame.$Properties
         * @property {Uint8Array|null} [ciphertext] MlsFrame ciphertext
         * @property {string|null} [groupId] MlsFrame groupId
         * @property {Array.<canari.Recipient.$Properties>|null} [recipients] MlsFrame recipients
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of a MlsFrame.
         * @memberof canari
         * @interface IMlsFrame
         * @augments canari.MlsFrame.$Properties
         * @deprecated Use canari.MlsFrame.$Properties instead.
         */

        /**
         * Shape of a MlsFrame.
         * @typedef {canari.MlsFrame.$Properties} canari.MlsFrame.$Shape
         */

        /**
         * Constructs a new MlsFrame.
         * @memberof canari
         * @classdesc Represents a MlsFrame.
         * @constructor
         * @param {canari.MlsFrame.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        const MlsFrame = function (properties) {
            this.recipients = [];
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        /**
         * MlsFrame ciphertext.
         * @member {Uint8Array} ciphertext
         * @memberof canari.MlsFrame
         * @instance
         */
        MlsFrame.prototype.ciphertext = $util.newBuffer([]);

        /**
         * MlsFrame groupId.
         * @member {string} groupId
         * @memberof canari.MlsFrame
         * @instance
         */
        MlsFrame.prototype.groupId = "";

        /**
         * MlsFrame recipients.
         * @member {Array.<canari.Recipient.$Properties>} recipients
         * @memberof canari.MlsFrame
         * @instance
         */
        MlsFrame.prototype.recipients = $util.emptyArray;

        /**
         * Creates a new MlsFrame instance using the specified properties.
         * @function create
         * @memberof canari.MlsFrame
         * @static
         * @param {canari.MlsFrame.$Properties=} [properties] Properties to set
         * @returns {canari.MlsFrame} MlsFrame instance
         * @type {{
         *   (properties: canari.MlsFrame.$Shape): canari.MlsFrame & canari.MlsFrame.$Shape;
         *   (properties?: canari.MlsFrame.$Properties): canari.MlsFrame;
         * }}
         */
        MlsFrame.create = function(properties) {
            return new MlsFrame(properties);
        };

        /**
         * Encodes the specified MlsFrame message. Does not implicitly {@link canari.MlsFrame.verify|verify} messages.
         * @function encode
         * @memberof canari.MlsFrame
         * @static
         * @param {canari.MlsFrame.$Properties} message MlsFrame message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        MlsFrame.encode = function (message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            if (message.ciphertext != null && $Object.hasOwnProperty.call(message, "ciphertext"))
                writer.uint32(/* id 1, wireType 2 =*/10).bytes(message.ciphertext);
            if (message.groupId != null && $Object.hasOwnProperty.call(message, "groupId"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.groupId);
            if (message.recipients != null && message.recipients.length)
                for (let i = 0; i < message.recipients.length; ++i)
                    $root.canari.Recipient.encode(message.recipients[i], writer.uint32(/* id 3, wireType 2 =*/26).fork(), _depth + 1).ldelim();
            if (message.$unknowns != null && $Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified MlsFrame message, length delimited. Does not implicitly {@link canari.MlsFrame.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.MlsFrame
         * @static
         * @param {canari.MlsFrame.$Properties} message MlsFrame message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        MlsFrame.encodeDelimited = function(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes a MlsFrame message from the specified reader or buffer.
         * @function decode
         * @memberof canari.MlsFrame
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.MlsFrame & canari.MlsFrame.$Shape} MlsFrame
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        MlsFrame.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end = length === $undefined ? reader.len : reader.pos + length, message = _target || new $root.canari.MlsFrame(), value;
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.bytes()).length)
                            message.ciphertext = value;
                        else
                            delete message.ciphertext;
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.groupId = value;
                        else
                            delete message.groupId;
                        continue;
                    }
                case 3: {
                        if (wireType !== 2)
                            break;
                        if (!(message.recipients && message.recipients.length))
                            message.recipients = [];
                        message.recipients.push($root.canari.Recipient.decode(reader, reader.uint32(), $undefined, _depth + 1));
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            return message;
        };

        /**
         * Decodes a MlsFrame message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.MlsFrame
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.MlsFrame & canari.MlsFrame.$Shape} MlsFrame
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        MlsFrame.decodeDelimited = function(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a MlsFrame message.
         * @function verify
         * @memberof canari.MlsFrame
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        MlsFrame.verify = function (message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.ciphertext != null && $Object.hasOwnProperty.call(message, "ciphertext"))
                if (!(message.ciphertext && typeof message.ciphertext.length === "number" || $util.isString(message.ciphertext)))
                    return "ciphertext: buffer expected";
            if (message.groupId != null && $Object.hasOwnProperty.call(message, "groupId"))
                if (!$util.isString(message.groupId))
                    return "groupId: string expected";
            if (message.recipients != null && $Object.hasOwnProperty.call(message, "recipients")) {
                if (!$Array.isArray(message.recipients))
                    return "recipients: array expected";
                for (let i = 0; i < message.recipients.length; ++i) {
                    let error = $root.canari.Recipient.verify(message.recipients[i], _depth + 1);
                    if (error)
                        return "recipients." + error;
                }
            }
            return null;
        };

        /**
         * Creates a MlsFrame message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof canari.MlsFrame
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {canari.MlsFrame} MlsFrame
         */
        MlsFrame.fromObject = function (object, _depth) {
            if (object instanceof $root.canari.MlsFrame)
                return object;
            if (!$util.isObject(object))
                throw $TypeError(".canari.MlsFrame: object expected");
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let message = new $root.canari.MlsFrame();
            if (object.ciphertext != null)
                if (object.ciphertext.length)
                    if (typeof object.ciphertext === "string")
                        $util.base64.decode(object.ciphertext, message.ciphertext = $util.newBuffer($util.base64.length(object.ciphertext)), 0);
                    else if (object.ciphertext.length >= 0)
                        message.ciphertext = object.ciphertext;
            if (object.groupId != null)
                if (typeof object.groupId !== "string" || object.groupId.length)
                    message.groupId = $String(object.groupId);
            if (object.recipients) {
                if (!$Array.isArray(object.recipients))
                    throw $TypeError(".canari.MlsFrame.recipients: array expected");
                message.recipients = $Array(object.recipients.length);
                for (let i = 0; i < object.recipients.length; ++i) {
                    if (!$util.isObject(object.recipients[i]))
                        throw $TypeError(".canari.MlsFrame.recipients: object expected");
                    message.recipients[i] = $root.canari.Recipient.fromObject(object.recipients[i], _depth + 1);
                }
            }
            return message;
        };

        /**
         * Creates a plain object from a MlsFrame message. Also converts values to other types if specified.
         * @function toObject
         * @memberof canari.MlsFrame
         * @static
         * @param {canari.MlsFrame} message MlsFrame
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        MlsFrame.toObject = function (message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let object = {};
            if (options.arrays || options.defaults)
                object.recipients = [];
            if (options.defaults) {
                if (options.bytes === $String)
                    object.ciphertext = "";
                else {
                    object.ciphertext = [];
                    if (options.bytes !== $Array)
                        object.ciphertext = $util.newBuffer(object.ciphertext);
                }
                object.groupId = "";
            }
            if (message.ciphertext != null && $Object.hasOwnProperty.call(message, "ciphertext"))
                object.ciphertext = options.bytes === $String ? $util.base64.encode(message.ciphertext, 0, message.ciphertext.length) : options.bytes === $Array ? $Array.prototype.slice.call(message.ciphertext) : message.ciphertext;
            if (message.groupId != null && $Object.hasOwnProperty.call(message, "groupId"))
                object.groupId = message.groupId;
            if (message.recipients && message.recipients.length) {
                object.recipients = $Array(message.recipients.length);
                for (let j = 0; j < message.recipients.length; ++j)
                    object.recipients[j] = $root.canari.Recipient.toObject(message.recipients[j], options, _depth + 1);
            }
            return object;
        };

        /**
         * Converts this MlsFrame to JSON.
         * @function toJSON
         * @memberof canari.MlsFrame
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        MlsFrame.prototype.toJSON = function() {
            return MlsFrame.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for MlsFrame
         * @function getTypeUrl
         * @memberof canari.MlsFrame
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        MlsFrame.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/canari.MlsFrame";
        };

        var C = MlsFrame;

        return MlsFrame;
    })();

    canari.WelcomeFrame = (function() {

        /**
         * Properties of a WelcomeFrame.
         * @typedef {Object} canari.WelcomeFrame.$Properties
         * @property {Uint8Array|null} [ciphertext] WelcomeFrame ciphertext
         * @property {string|null} [groupId] WelcomeFrame groupId
         * @property {Array.<canari.Recipient.$Properties>|null} [recipients] WelcomeFrame recipients
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of a WelcomeFrame.
         * @memberof canari
         * @interface IWelcomeFrame
         * @augments canari.WelcomeFrame.$Properties
         * @deprecated Use canari.WelcomeFrame.$Properties instead.
         */

        /**
         * Shape of a WelcomeFrame.
         * @typedef {canari.WelcomeFrame.$Properties} canari.WelcomeFrame.$Shape
         */

        /**
         * Constructs a new WelcomeFrame.
         * @memberof canari
         * @classdesc Represents a WelcomeFrame.
         * @constructor
         * @param {canari.WelcomeFrame.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        const WelcomeFrame = function (properties) {
            this.recipients = [];
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        /**
         * WelcomeFrame ciphertext.
         * @member {Uint8Array} ciphertext
         * @memberof canari.WelcomeFrame
         * @instance
         */
        WelcomeFrame.prototype.ciphertext = $util.newBuffer([]);

        /**
         * WelcomeFrame groupId.
         * @member {string} groupId
         * @memberof canari.WelcomeFrame
         * @instance
         */
        WelcomeFrame.prototype.groupId = "";

        /**
         * WelcomeFrame recipients.
         * @member {Array.<canari.Recipient.$Properties>} recipients
         * @memberof canari.WelcomeFrame
         * @instance
         */
        WelcomeFrame.prototype.recipients = $util.emptyArray;

        /**
         * Creates a new WelcomeFrame instance using the specified properties.
         * @function create
         * @memberof canari.WelcomeFrame
         * @static
         * @param {canari.WelcomeFrame.$Properties=} [properties] Properties to set
         * @returns {canari.WelcomeFrame} WelcomeFrame instance
         * @type {{
         *   (properties: canari.WelcomeFrame.$Shape): canari.WelcomeFrame & canari.WelcomeFrame.$Shape;
         *   (properties?: canari.WelcomeFrame.$Properties): canari.WelcomeFrame;
         * }}
         */
        WelcomeFrame.create = function(properties) {
            return new WelcomeFrame(properties);
        };

        /**
         * Encodes the specified WelcomeFrame message. Does not implicitly {@link canari.WelcomeFrame.verify|verify} messages.
         * @function encode
         * @memberof canari.WelcomeFrame
         * @static
         * @param {canari.WelcomeFrame.$Properties} message WelcomeFrame message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        WelcomeFrame.encode = function (message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            if (message.ciphertext != null && $Object.hasOwnProperty.call(message, "ciphertext"))
                writer.uint32(/* id 1, wireType 2 =*/10).bytes(message.ciphertext);
            if (message.groupId != null && $Object.hasOwnProperty.call(message, "groupId"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.groupId);
            if (message.recipients != null && message.recipients.length)
                for (let i = 0; i < message.recipients.length; ++i)
                    $root.canari.Recipient.encode(message.recipients[i], writer.uint32(/* id 3, wireType 2 =*/26).fork(), _depth + 1).ldelim();
            if (message.$unknowns != null && $Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified WelcomeFrame message, length delimited. Does not implicitly {@link canari.WelcomeFrame.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.WelcomeFrame
         * @static
         * @param {canari.WelcomeFrame.$Properties} message WelcomeFrame message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        WelcomeFrame.encodeDelimited = function(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes a WelcomeFrame message from the specified reader or buffer.
         * @function decode
         * @memberof canari.WelcomeFrame
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.WelcomeFrame & canari.WelcomeFrame.$Shape} WelcomeFrame
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        WelcomeFrame.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end = length === $undefined ? reader.len : reader.pos + length, message = _target || new $root.canari.WelcomeFrame(), value;
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.bytes()).length)
                            message.ciphertext = value;
                        else
                            delete message.ciphertext;
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.groupId = value;
                        else
                            delete message.groupId;
                        continue;
                    }
                case 3: {
                        if (wireType !== 2)
                            break;
                        if (!(message.recipients && message.recipients.length))
                            message.recipients = [];
                        message.recipients.push($root.canari.Recipient.decode(reader, reader.uint32(), $undefined, _depth + 1));
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            return message;
        };

        /**
         * Decodes a WelcomeFrame message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.WelcomeFrame
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.WelcomeFrame & canari.WelcomeFrame.$Shape} WelcomeFrame
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        WelcomeFrame.decodeDelimited = function(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a WelcomeFrame message.
         * @function verify
         * @memberof canari.WelcomeFrame
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        WelcomeFrame.verify = function (message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.ciphertext != null && $Object.hasOwnProperty.call(message, "ciphertext"))
                if (!(message.ciphertext && typeof message.ciphertext.length === "number" || $util.isString(message.ciphertext)))
                    return "ciphertext: buffer expected";
            if (message.groupId != null && $Object.hasOwnProperty.call(message, "groupId"))
                if (!$util.isString(message.groupId))
                    return "groupId: string expected";
            if (message.recipients != null && $Object.hasOwnProperty.call(message, "recipients")) {
                if (!$Array.isArray(message.recipients))
                    return "recipients: array expected";
                for (let i = 0; i < message.recipients.length; ++i) {
                    let error = $root.canari.Recipient.verify(message.recipients[i], _depth + 1);
                    if (error)
                        return "recipients." + error;
                }
            }
            return null;
        };

        /**
         * Creates a WelcomeFrame message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof canari.WelcomeFrame
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {canari.WelcomeFrame} WelcomeFrame
         */
        WelcomeFrame.fromObject = function (object, _depth) {
            if (object instanceof $root.canari.WelcomeFrame)
                return object;
            if (!$util.isObject(object))
                throw $TypeError(".canari.WelcomeFrame: object expected");
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let message = new $root.canari.WelcomeFrame();
            if (object.ciphertext != null)
                if (object.ciphertext.length)
                    if (typeof object.ciphertext === "string")
                        $util.base64.decode(object.ciphertext, message.ciphertext = $util.newBuffer($util.base64.length(object.ciphertext)), 0);
                    else if (object.ciphertext.length >= 0)
                        message.ciphertext = object.ciphertext;
            if (object.groupId != null)
                if (typeof object.groupId !== "string" || object.groupId.length)
                    message.groupId = $String(object.groupId);
            if (object.recipients) {
                if (!$Array.isArray(object.recipients))
                    throw $TypeError(".canari.WelcomeFrame.recipients: array expected");
                message.recipients = $Array(object.recipients.length);
                for (let i = 0; i < object.recipients.length; ++i) {
                    if (!$util.isObject(object.recipients[i]))
                        throw $TypeError(".canari.WelcomeFrame.recipients: object expected");
                    message.recipients[i] = $root.canari.Recipient.fromObject(object.recipients[i], _depth + 1);
                }
            }
            return message;
        };

        /**
         * Creates a plain object from a WelcomeFrame message. Also converts values to other types if specified.
         * @function toObject
         * @memberof canari.WelcomeFrame
         * @static
         * @param {canari.WelcomeFrame} message WelcomeFrame
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        WelcomeFrame.toObject = function (message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let object = {};
            if (options.arrays || options.defaults)
                object.recipients = [];
            if (options.defaults) {
                if (options.bytes === $String)
                    object.ciphertext = "";
                else {
                    object.ciphertext = [];
                    if (options.bytes !== $Array)
                        object.ciphertext = $util.newBuffer(object.ciphertext);
                }
                object.groupId = "";
            }
            if (message.ciphertext != null && $Object.hasOwnProperty.call(message, "ciphertext"))
                object.ciphertext = options.bytes === $String ? $util.base64.encode(message.ciphertext, 0, message.ciphertext.length) : options.bytes === $Array ? $Array.prototype.slice.call(message.ciphertext) : message.ciphertext;
            if (message.groupId != null && $Object.hasOwnProperty.call(message, "groupId"))
                object.groupId = message.groupId;
            if (message.recipients && message.recipients.length) {
                object.recipients = $Array(message.recipients.length);
                for (let j = 0; j < message.recipients.length; ++j)
                    object.recipients[j] = $root.canari.Recipient.toObject(message.recipients[j], options, _depth + 1);
            }
            return object;
        };

        /**
         * Converts this WelcomeFrame to JSON.
         * @function toJSON
         * @memberof canari.WelcomeFrame
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        WelcomeFrame.prototype.toJSON = function() {
            return WelcomeFrame.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for WelcomeFrame
         * @function getTypeUrl
         * @memberof canari.WelcomeFrame
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        WelcomeFrame.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/canari.WelcomeFrame";
        };

        var C = WelcomeFrame;

        return WelcomeFrame;
    })();

    canari.ReadAck = (function() {

        /**
         * Properties of a ReadAck.
         * @typedef {Object} canari.ReadAck.$Properties
         * @property {string|null} [messageId] ReadAck messageId
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of a ReadAck.
         * @memberof canari
         * @interface IReadAck
         * @augments canari.ReadAck.$Properties
         * @deprecated Use canari.ReadAck.$Properties instead.
         */

        /**
         * Shape of a ReadAck.
         * @typedef {canari.ReadAck.$Properties} canari.ReadAck.$Shape
         */

        /**
         * Constructs a new ReadAck.
         * @memberof canari
         * @classdesc Represents a ReadAck.
         * @constructor
         * @param {canari.ReadAck.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        const ReadAck = function (properties) {
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        /**
         * ReadAck messageId.
         * @member {string} messageId
         * @memberof canari.ReadAck
         * @instance
         */
        ReadAck.prototype.messageId = "";

        /**
         * Creates a new ReadAck instance using the specified properties.
         * @function create
         * @memberof canari.ReadAck
         * @static
         * @param {canari.ReadAck.$Properties=} [properties] Properties to set
         * @returns {canari.ReadAck} ReadAck instance
         * @type {{
         *   (properties: canari.ReadAck.$Shape): canari.ReadAck & canari.ReadAck.$Shape;
         *   (properties?: canari.ReadAck.$Properties): canari.ReadAck;
         * }}
         */
        ReadAck.create = function(properties) {
            return new ReadAck(properties);
        };

        /**
         * Encodes the specified ReadAck message. Does not implicitly {@link canari.ReadAck.verify|verify} messages.
         * @function encode
         * @memberof canari.ReadAck
         * @static
         * @param {canari.ReadAck.$Properties} message ReadAck message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        ReadAck.encode = function (message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            if (message.messageId != null && $Object.hasOwnProperty.call(message, "messageId"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.messageId);
            if (message.$unknowns != null && $Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified ReadAck message, length delimited. Does not implicitly {@link canari.ReadAck.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.ReadAck
         * @static
         * @param {canari.ReadAck.$Properties} message ReadAck message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        ReadAck.encodeDelimited = function(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes a ReadAck message from the specified reader or buffer.
         * @function decode
         * @memberof canari.ReadAck
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.ReadAck & canari.ReadAck.$Shape} ReadAck
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        ReadAck.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end = length === $undefined ? reader.len : reader.pos + length, message = _target || new $root.canari.ReadAck(), value;
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.messageId = value;
                        else
                            delete message.messageId;
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            return message;
        };

        /**
         * Decodes a ReadAck message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.ReadAck
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.ReadAck & canari.ReadAck.$Shape} ReadAck
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        ReadAck.decodeDelimited = function(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a ReadAck message.
         * @function verify
         * @memberof canari.ReadAck
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        ReadAck.verify = function (message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.messageId != null && $Object.hasOwnProperty.call(message, "messageId"))
                if (!$util.isString(message.messageId))
                    return "messageId: string expected";
            return null;
        };

        /**
         * Creates a ReadAck message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof canari.ReadAck
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {canari.ReadAck} ReadAck
         */
        ReadAck.fromObject = function (object, _depth) {
            if (object instanceof $root.canari.ReadAck)
                return object;
            if (!$util.isObject(object))
                throw $TypeError(".canari.ReadAck: object expected");
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let message = new $root.canari.ReadAck();
            if (object.messageId != null)
                if (typeof object.messageId !== "string" || object.messageId.length)
                    message.messageId = $String(object.messageId);
            return message;
        };

        /**
         * Creates a plain object from a ReadAck message. Also converts values to other types if specified.
         * @function toObject
         * @memberof canari.ReadAck
         * @static
         * @param {canari.ReadAck} message ReadAck
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        ReadAck.toObject = function (message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let object = {};
            if (options.defaults)
                object.messageId = "";
            if (message.messageId != null && $Object.hasOwnProperty.call(message, "messageId"))
                object.messageId = message.messageId;
            return object;
        };

        /**
         * Converts this ReadAck to JSON.
         * @function toJSON
         * @memberof canari.ReadAck
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        ReadAck.prototype.toJSON = function() {
            return ReadAck.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for ReadAck
         * @function getTypeUrl
         * @memberof canari.ReadAck
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        ReadAck.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/canari.ReadAck";
        };

        var C = ReadAck;

        return ReadAck;
    })();

    canari.InboundMsg = (function() {

        /**
         * Properties of an InboundMsg.
         * @typedef {Object} canari.InboundMsg.$Properties
         * @property {Uint8Array|null} [ciphertext] InboundMsg ciphertext
         * @property {string|null} [senderId] InboundMsg senderId
         * @property {string|null} [senderDeviceId] InboundMsg senderDeviceId
         * @property {string|null} [groupId] InboundMsg groupId
         * @property {boolean|null} [isWelcome] InboundMsg isWelcome
         * @property {boolean|null} [isCommit] InboundMsg isCommit
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of an InboundMsg.
         * @memberof canari
         * @interface IInboundMsg
         * @augments canari.InboundMsg.$Properties
         * @deprecated Use canari.InboundMsg.$Properties instead.
         */

        /**
         * Shape of an InboundMsg.
         * @typedef {canari.InboundMsg.$Properties} canari.InboundMsg.$Shape
         */

        /**
         * Constructs a new InboundMsg.
         * @memberof canari
         * @classdesc Represents an InboundMsg.
         * @constructor
         * @param {canari.InboundMsg.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        const InboundMsg = function (properties) {
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        /**
         * InboundMsg ciphertext.
         * @member {Uint8Array} ciphertext
         * @memberof canari.InboundMsg
         * @instance
         */
        InboundMsg.prototype.ciphertext = $util.newBuffer([]);

        /**
         * InboundMsg senderId.
         * @member {string} senderId
         * @memberof canari.InboundMsg
         * @instance
         */
        InboundMsg.prototype.senderId = "";

        /**
         * InboundMsg senderDeviceId.
         * @member {string} senderDeviceId
         * @memberof canari.InboundMsg
         * @instance
         */
        InboundMsg.prototype.senderDeviceId = "";

        /**
         * InboundMsg groupId.
         * @member {string} groupId
         * @memberof canari.InboundMsg
         * @instance
         */
        InboundMsg.prototype.groupId = "";

        /**
         * InboundMsg isWelcome.
         * @member {boolean} isWelcome
         * @memberof canari.InboundMsg
         * @instance
         */
        InboundMsg.prototype.isWelcome = false;

        /**
         * InboundMsg isCommit.
         * @member {boolean} isCommit
         * @memberof canari.InboundMsg
         * @instance
         */
        InboundMsg.prototype.isCommit = false;

        /**
         * Creates a new InboundMsg instance using the specified properties.
         * @function create
         * @memberof canari.InboundMsg
         * @static
         * @param {canari.InboundMsg.$Properties=} [properties] Properties to set
         * @returns {canari.InboundMsg} InboundMsg instance
         * @type {{
         *   (properties: canari.InboundMsg.$Shape): canari.InboundMsg & canari.InboundMsg.$Shape;
         *   (properties?: canari.InboundMsg.$Properties): canari.InboundMsg;
         * }}
         */
        InboundMsg.create = function(properties) {
            return new InboundMsg(properties);
        };

        /**
         * Encodes the specified InboundMsg message. Does not implicitly {@link canari.InboundMsg.verify|verify} messages.
         * @function encode
         * @memberof canari.InboundMsg
         * @static
         * @param {canari.InboundMsg.$Properties} message InboundMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        InboundMsg.encode = function (message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            if (message.ciphertext != null && $Object.hasOwnProperty.call(message, "ciphertext"))
                writer.uint32(/* id 1, wireType 2 =*/10).bytes(message.ciphertext);
            if (message.senderId != null && $Object.hasOwnProperty.call(message, "senderId"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.senderId);
            if (message.senderDeviceId != null && $Object.hasOwnProperty.call(message, "senderDeviceId"))
                writer.uint32(/* id 3, wireType 2 =*/26).string(message.senderDeviceId);
            if (message.groupId != null && $Object.hasOwnProperty.call(message, "groupId"))
                writer.uint32(/* id 4, wireType 2 =*/34).string(message.groupId);
            if (message.isWelcome != null && $Object.hasOwnProperty.call(message, "isWelcome"))
                writer.uint32(/* id 5, wireType 0 =*/40).bool(message.isWelcome);
            if (message.isCommit != null && $Object.hasOwnProperty.call(message, "isCommit"))
                writer.uint32(/* id 6, wireType 0 =*/48).bool(message.isCommit);
            if (message.$unknowns != null && $Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified InboundMsg message, length delimited. Does not implicitly {@link canari.InboundMsg.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.InboundMsg
         * @static
         * @param {canari.InboundMsg.$Properties} message InboundMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        InboundMsg.encodeDelimited = function(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes an InboundMsg message from the specified reader or buffer.
         * @function decode
         * @memberof canari.InboundMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.InboundMsg & canari.InboundMsg.$Shape} InboundMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        InboundMsg.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end = length === $undefined ? reader.len : reader.pos + length, message = _target || new $root.canari.InboundMsg(), value;
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.bytes()).length)
                            message.ciphertext = value;
                        else
                            delete message.ciphertext;
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.senderId = value;
                        else
                            delete message.senderId;
                        continue;
                    }
                case 3: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.senderDeviceId = value;
                        else
                            delete message.senderDeviceId;
                        continue;
                    }
                case 4: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.groupId = value;
                        else
                            delete message.groupId;
                        continue;
                    }
                case 5: {
                        if (wireType !== 0)
                            break;
                        if (value = reader.bool())
                            message.isWelcome = value;
                        else
                            delete message.isWelcome;
                        continue;
                    }
                case 6: {
                        if (wireType !== 0)
                            break;
                        if (value = reader.bool())
                            message.isCommit = value;
                        else
                            delete message.isCommit;
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            return message;
        };

        /**
         * Decodes an InboundMsg message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.InboundMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.InboundMsg & canari.InboundMsg.$Shape} InboundMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        InboundMsg.decodeDelimited = function(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies an InboundMsg message.
         * @function verify
         * @memberof canari.InboundMsg
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        InboundMsg.verify = function (message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.ciphertext != null && $Object.hasOwnProperty.call(message, "ciphertext"))
                if (!(message.ciphertext && typeof message.ciphertext.length === "number" || $util.isString(message.ciphertext)))
                    return "ciphertext: buffer expected";
            if (message.senderId != null && $Object.hasOwnProperty.call(message, "senderId"))
                if (!$util.isString(message.senderId))
                    return "senderId: string expected";
            if (message.senderDeviceId != null && $Object.hasOwnProperty.call(message, "senderDeviceId"))
                if (!$util.isString(message.senderDeviceId))
                    return "senderDeviceId: string expected";
            if (message.groupId != null && $Object.hasOwnProperty.call(message, "groupId"))
                if (!$util.isString(message.groupId))
                    return "groupId: string expected";
            if (message.isWelcome != null && $Object.hasOwnProperty.call(message, "isWelcome"))
                if (typeof message.isWelcome !== "boolean")
                    return "isWelcome: boolean expected";
            if (message.isCommit != null && $Object.hasOwnProperty.call(message, "isCommit"))
                if (typeof message.isCommit !== "boolean")
                    return "isCommit: boolean expected";
            return null;
        };

        /**
         * Creates an InboundMsg message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof canari.InboundMsg
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {canari.InboundMsg} InboundMsg
         */
        InboundMsg.fromObject = function (object, _depth) {
            if (object instanceof $root.canari.InboundMsg)
                return object;
            if (!$util.isObject(object))
                throw $TypeError(".canari.InboundMsg: object expected");
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let message = new $root.canari.InboundMsg();
            if (object.ciphertext != null)
                if (object.ciphertext.length)
                    if (typeof object.ciphertext === "string")
                        $util.base64.decode(object.ciphertext, message.ciphertext = $util.newBuffer($util.base64.length(object.ciphertext)), 0);
                    else if (object.ciphertext.length >= 0)
                        message.ciphertext = object.ciphertext;
            if (object.senderId != null)
                if (typeof object.senderId !== "string" || object.senderId.length)
                    message.senderId = $String(object.senderId);
            if (object.senderDeviceId != null)
                if (typeof object.senderDeviceId !== "string" || object.senderDeviceId.length)
                    message.senderDeviceId = $String(object.senderDeviceId);
            if (object.groupId != null)
                if (typeof object.groupId !== "string" || object.groupId.length)
                    message.groupId = $String(object.groupId);
            if (object.isWelcome != null)
                if (object.isWelcome)
                    message.isWelcome = $Boolean(object.isWelcome);
            if (object.isCommit != null)
                if (object.isCommit)
                    message.isCommit = $Boolean(object.isCommit);
            return message;
        };

        /**
         * Creates a plain object from an InboundMsg message. Also converts values to other types if specified.
         * @function toObject
         * @memberof canari.InboundMsg
         * @static
         * @param {canari.InboundMsg} message InboundMsg
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        InboundMsg.toObject = function (message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let object = {};
            if (options.defaults) {
                if (options.bytes === $String)
                    object.ciphertext = "";
                else {
                    object.ciphertext = [];
                    if (options.bytes !== $Array)
                        object.ciphertext = $util.newBuffer(object.ciphertext);
                }
                object.senderId = "";
                object.senderDeviceId = "";
                object.groupId = "";
                object.isWelcome = false;
                object.isCommit = false;
            }
            if (message.ciphertext != null && $Object.hasOwnProperty.call(message, "ciphertext"))
                object.ciphertext = options.bytes === $String ? $util.base64.encode(message.ciphertext, 0, message.ciphertext.length) : options.bytes === $Array ? $Array.prototype.slice.call(message.ciphertext) : message.ciphertext;
            if (message.senderId != null && $Object.hasOwnProperty.call(message, "senderId"))
                object.senderId = message.senderId;
            if (message.senderDeviceId != null && $Object.hasOwnProperty.call(message, "senderDeviceId"))
                object.senderDeviceId = message.senderDeviceId;
            if (message.groupId != null && $Object.hasOwnProperty.call(message, "groupId"))
                object.groupId = message.groupId;
            if (message.isWelcome != null && $Object.hasOwnProperty.call(message, "isWelcome"))
                object.isWelcome = message.isWelcome;
            if (message.isCommit != null && $Object.hasOwnProperty.call(message, "isCommit"))
                object.isCommit = message.isCommit;
            return object;
        };

        /**
         * Converts this InboundMsg to JSON.
         * @function toJSON
         * @memberof canari.InboundMsg
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        InboundMsg.prototype.toJSON = function() {
            return InboundMsg.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for InboundMsg
         * @function getTypeUrl
         * @memberof canari.InboundMsg
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        InboundMsg.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/canari.InboundMsg";
        };

        var C = InboundMsg;

        return InboundMsg;
    })();

    canari.AppMessage = (function() {

        /**
         * Properties of an AppMessage.
         * @typedef {Object} canari.AppMessage.$Properties
         * @property {string|null} [messageId] AppMessage messageId
         * @property {number|null} [sentAt] AppMessage sentAt
         * @property {canari.TextMsg.$Properties|null} [text] AppMessage text
         * @property {canari.ReplyMsg.$Properties|null} [reply] AppMessage reply
         * @property {canari.ReactionMsg.$Properties|null} [reaction] AppMessage reaction
         * @property {canari.MediaMsg.$Properties|null} [media] AppMessage media
         * @property {canari.SystemMsg.$Properties|null} [system] AppMessage system
         * @property {canari.CallMsg.$Properties|null} [call] AppMessage call
         * @property {canari.PollMsg.$Properties|null} [poll] AppMessage poll
         * @property {"text"|"reply"|"reaction"|"media"|"system"|"call"|"poll"} [kind] AppMessage kind
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of an AppMessage.
         * @memberof canari
         * @interface IAppMessage
         * @augments canari.AppMessage.$Properties
         * @deprecated Use canari.AppMessage.$Properties instead.
         */

        /**
         * Narrowed shape of an AppMessage.
         * @typedef {{
         *   messageId?: string|null;
         *   sentAt?: number|null;
         *   text?: canari.TextMsg.$Shape|null;
         *   reply?: canari.ReplyMsg.$Shape|null;
         *   reaction?: canari.ReactionMsg.$Shape|null;
         *   media?: canari.MediaMsg.$Shape|null;
         *   system?: canari.SystemMsg.$Shape|null;
         *   call?: canari.CallMsg.$Shape|null;
         *   poll?: canari.PollMsg.$Shape|null;
         *   $unknowns?: Array.<Uint8Array>;
         * } & (
         *   ({ kind?: undefined; text?: null; reply?: null; reaction?: null; media?: null; system?: null; call?: null; poll?: null }|{ kind?: "text"; text: canari.TextMsg.$Shape; reply?: null; reaction?: null; media?: null; system?: null; call?: null; poll?: null }|{ kind?: "reply"; text?: null; reply: canari.ReplyMsg.$Shape; reaction?: null; media?: null; system?: null; call?: null; poll?: null }|{ kind?: "reaction"; text?: null; reply?: null; reaction: canari.ReactionMsg.$Shape; media?: null; system?: null; call?: null; poll?: null }|{ kind?: "media"; text?: null; reply?: null; reaction?: null; media: canari.MediaMsg.$Shape; system?: null; call?: null; poll?: null }|{ kind?: "system"; text?: null; reply?: null; reaction?: null; media?: null; system: canari.SystemMsg.$Shape; call?: null; poll?: null }|{ kind?: "call"; text?: null; reply?: null; reaction?: null; media?: null; system?: null; call: canari.CallMsg.$Shape; poll?: null }|{ kind?: "poll"; text?: null; reply?: null; reaction?: null; media?: null; system?: null; call?: null; poll: canari.PollMsg.$Shape })
         * )} canari.AppMessage.$Shape
         */

        /**
         * Constructs a new AppMessage.
         * @memberof canari
         * @classdesc Represents an AppMessage.
         * @constructor
         * @param {canari.AppMessage.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        const AppMessage = function (properties) {
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        /**
         * AppMessage messageId.
         * @member {string} messageId
         * @memberof canari.AppMessage
         * @instance
         */
        AppMessage.prototype.messageId = "";

        /**
         * AppMessage sentAt.
         * @member {number} sentAt
         * @memberof canari.AppMessage
         * @instance
         */
        AppMessage.prototype.sentAt = $util.Long ? $util.Long.fromBits(0,0,false) : 0;

        /**
         * AppMessage text.
         * @member {canari.TextMsg.$Properties|null|undefined} text
         * @memberof canari.AppMessage
         * @instance
         */
        AppMessage.prototype.text = null;

        /**
         * AppMessage reply.
         * @member {canari.ReplyMsg.$Properties|null|undefined} reply
         * @memberof canari.AppMessage
         * @instance
         */
        AppMessage.prototype.reply = null;

        /**
         * AppMessage reaction.
         * @member {canari.ReactionMsg.$Properties|null|undefined} reaction
         * @memberof canari.AppMessage
         * @instance
         */
        AppMessage.prototype.reaction = null;

        /**
         * AppMessage media.
         * @member {canari.MediaMsg.$Properties|null|undefined} media
         * @memberof canari.AppMessage
         * @instance
         */
        AppMessage.prototype.media = null;

        /**
         * AppMessage system.
         * @member {canari.SystemMsg.$Properties|null|undefined} system
         * @memberof canari.AppMessage
         * @instance
         */
        AppMessage.prototype.system = null;

        /**
         * AppMessage call.
         * @member {canari.CallMsg.$Properties|null|undefined} call
         * @memberof canari.AppMessage
         * @instance
         */
        AppMessage.prototype.call = null;

        /**
         * AppMessage poll.
         * @member {canari.PollMsg.$Properties|null|undefined} poll
         * @memberof canari.AppMessage
         * @instance
         */
        AppMessage.prototype.poll = null;

        // OneOf field names bound to virtual getters and setters
        let $oneOfFields;

        /**
         * AppMessage kind.
         * @member {"text"|"reply"|"reaction"|"media"|"system"|"call"|"poll"|undefined} kind
         * @memberof canari.AppMessage
         * @instance
         */
        $Object.defineProperty(AppMessage.prototype, "kind", {
            get: $util.oneOfGetter($oneOfFields = ["text", "reply", "reaction", "media", "system", "call", "poll"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        /**
         * Creates a new AppMessage instance using the specified properties.
         * @function create
         * @memberof canari.AppMessage
         * @static
         * @param {canari.AppMessage.$Properties=} [properties] Properties to set
         * @returns {canari.AppMessage} AppMessage instance
         * @type {{
         *   (properties: canari.AppMessage.$Shape): canari.AppMessage & canari.AppMessage.$Shape;
         *   (properties?: canari.AppMessage.$Properties): canari.AppMessage;
         * }}
         */
        AppMessage.create = function(properties) {
            return new AppMessage(properties);
        };

        /**
         * Encodes the specified AppMessage message. Does not implicitly {@link canari.AppMessage.verify|verify} messages.
         * @function encode
         * @memberof canari.AppMessage
         * @static
         * @param {canari.AppMessage.$Properties} message AppMessage message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        AppMessage.encode = function (message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            if (message.text != null && $Object.hasOwnProperty.call(message, "text"))
                $root.canari.TextMsg.encode(message.text, writer.uint32(/* id 1, wireType 2 =*/10).fork(), _depth + 1).ldelim();
            if (message.reply != null && $Object.hasOwnProperty.call(message, "reply"))
                $root.canari.ReplyMsg.encode(message.reply, writer.uint32(/* id 2, wireType 2 =*/18).fork(), _depth + 1).ldelim();
            if (message.reaction != null && $Object.hasOwnProperty.call(message, "reaction"))
                $root.canari.ReactionMsg.encode(message.reaction, writer.uint32(/* id 3, wireType 2 =*/26).fork(), _depth + 1).ldelim();
            if (message.media != null && $Object.hasOwnProperty.call(message, "media"))
                $root.canari.MediaMsg.encode(message.media, writer.uint32(/* id 4, wireType 2 =*/34).fork(), _depth + 1).ldelim();
            if (message.system != null && $Object.hasOwnProperty.call(message, "system"))
                $root.canari.SystemMsg.encode(message.system, writer.uint32(/* id 5, wireType 2 =*/42).fork(), _depth + 1).ldelim();
            if (message.messageId != null && $Object.hasOwnProperty.call(message, "messageId"))
                writer.uint32(/* id 6, wireType 2 =*/50).string(message.messageId);
            if (message.call != null && $Object.hasOwnProperty.call(message, "call"))
                $root.canari.CallMsg.encode(message.call, writer.uint32(/* id 7, wireType 2 =*/58).fork(), _depth + 1).ldelim();
            if (message.sentAt != null && $Object.hasOwnProperty.call(message, "sentAt"))
                writer.uint32(/* id 8, wireType 0 =*/64).int64(message.sentAt);
            if (message.poll != null && $Object.hasOwnProperty.call(message, "poll"))
                $root.canari.PollMsg.encode(message.poll, writer.uint32(/* id 9, wireType 2 =*/74).fork(), _depth + 1).ldelim();
            if (message.$unknowns != null && $Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified AppMessage message, length delimited. Does not implicitly {@link canari.AppMessage.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.AppMessage
         * @static
         * @param {canari.AppMessage.$Properties} message AppMessage message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        AppMessage.encodeDelimited = function(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes an AppMessage message from the specified reader or buffer.
         * @function decode
         * @memberof canari.AppMessage
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.AppMessage & canari.AppMessage.$Shape} AppMessage
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        AppMessage.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end = length === $undefined ? reader.len : reader.pos + length, message = _target || new $root.canari.AppMessage(), value;
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 6: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.messageId = value;
                        else
                            delete message.messageId;
                        continue;
                    }
                case 8: {
                        if (wireType !== 0)
                            break;
                        if (typeof (value = reader.int64()) === "object" ? value.low || value.high : value !== 0)
                            message.sentAt = value;
                        else
                            delete message.sentAt;
                        continue;
                    }
                case 1: {
                        if (wireType !== 2)
                            break;
                        message.text = $root.canari.TextMsg.decode(reader, reader.uint32(), $undefined, _depth + 1, message.text);
                        message.kind = "text";
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        message.reply = $root.canari.ReplyMsg.decode(reader, reader.uint32(), $undefined, _depth + 1, message.reply);
                        message.kind = "reply";
                        continue;
                    }
                case 3: {
                        if (wireType !== 2)
                            break;
                        message.reaction = $root.canari.ReactionMsg.decode(reader, reader.uint32(), $undefined, _depth + 1, message.reaction);
                        message.kind = "reaction";
                        continue;
                    }
                case 4: {
                        if (wireType !== 2)
                            break;
                        message.media = $root.canari.MediaMsg.decode(reader, reader.uint32(), $undefined, _depth + 1, message.media);
                        message.kind = "media";
                        continue;
                    }
                case 5: {
                        if (wireType !== 2)
                            break;
                        message.system = $root.canari.SystemMsg.decode(reader, reader.uint32(), $undefined, _depth + 1, message.system);
                        message.kind = "system";
                        continue;
                    }
                case 7: {
                        if (wireType !== 2)
                            break;
                        message.call = $root.canari.CallMsg.decode(reader, reader.uint32(), $undefined, _depth + 1, message.call);
                        message.kind = "call";
                        continue;
                    }
                case 9: {
                        if (wireType !== 2)
                            break;
                        message.poll = $root.canari.PollMsg.decode(reader, reader.uint32(), $undefined, _depth + 1, message.poll);
                        message.kind = "poll";
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            return message;
        };

        /**
         * Decodes an AppMessage message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.AppMessage
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.AppMessage & canari.AppMessage.$Shape} AppMessage
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        AppMessage.decodeDelimited = function(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies an AppMessage message.
         * @function verify
         * @memberof canari.AppMessage
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        AppMessage.verify = function (message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            let properties = {};
            if (message.messageId != null && $Object.hasOwnProperty.call(message, "messageId"))
                if (!$util.isString(message.messageId))
                    return "messageId: string expected";
            if (message.sentAt != null && $Object.hasOwnProperty.call(message, "sentAt"))
                if (!$util.isInteger(message.sentAt) && !(message.sentAt && $util.isInteger(message.sentAt.low) && $util.isInteger(message.sentAt.high)))
                    return "sentAt: integer|Long expected";
            if (message.text != null && $Object.hasOwnProperty.call(message, "text")) {
                properties.kind = 1;
                {
                    let error = $root.canari.TextMsg.verify(message.text, _depth + 1);
                    if (error)
                        return "text." + error;
                }
            }
            if (message.reply != null && $Object.hasOwnProperty.call(message, "reply")) {
                if (properties.kind === 1)
                    return "kind: multiple values";
                properties.kind = 1;
                {
                    let error = $root.canari.ReplyMsg.verify(message.reply, _depth + 1);
                    if (error)
                        return "reply." + error;
                }
            }
            if (message.reaction != null && $Object.hasOwnProperty.call(message, "reaction")) {
                if (properties.kind === 1)
                    return "kind: multiple values";
                properties.kind = 1;
                {
                    let error = $root.canari.ReactionMsg.verify(message.reaction, _depth + 1);
                    if (error)
                        return "reaction." + error;
                }
            }
            if (message.media != null && $Object.hasOwnProperty.call(message, "media")) {
                if (properties.kind === 1)
                    return "kind: multiple values";
                properties.kind = 1;
                {
                    let error = $root.canari.MediaMsg.verify(message.media, _depth + 1);
                    if (error)
                        return "media." + error;
                }
            }
            if (message.system != null && $Object.hasOwnProperty.call(message, "system")) {
                if (properties.kind === 1)
                    return "kind: multiple values";
                properties.kind = 1;
                {
                    let error = $root.canari.SystemMsg.verify(message.system, _depth + 1);
                    if (error)
                        return "system." + error;
                }
            }
            if (message.call != null && $Object.hasOwnProperty.call(message, "call")) {
                if (properties.kind === 1)
                    return "kind: multiple values";
                properties.kind = 1;
                {
                    let error = $root.canari.CallMsg.verify(message.call, _depth + 1);
                    if (error)
                        return "call." + error;
                }
            }
            if (message.poll != null && $Object.hasOwnProperty.call(message, "poll")) {
                if (properties.kind === 1)
                    return "kind: multiple values";
                properties.kind = 1;
                {
                    let error = $root.canari.PollMsg.verify(message.poll, _depth + 1);
                    if (error)
                        return "poll." + error;
                }
            }
            return null;
        };

        /**
         * Creates an AppMessage message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof canari.AppMessage
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {canari.AppMessage} AppMessage
         */
        AppMessage.fromObject = function (object, _depth) {
            if (object instanceof $root.canari.AppMessage)
                return object;
            if (!$util.isObject(object))
                throw $TypeError(".canari.AppMessage: object expected");
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let message = new $root.canari.AppMessage();
            if (object.messageId != null)
                if (typeof object.messageId !== "string" || object.messageId.length)
                    message.messageId = $String(object.messageId);
            if (object.sentAt != null)
                if (typeof object.sentAt === "object" ? object.sentAt.low || object.sentAt.high : $Number(object.sentAt) !== 0)
                    if ($util.Long)
                        message.sentAt = $util.Long.fromValue(object.sentAt, false);
                    else if (typeof object.sentAt === "string")
                        message.sentAt = $parseInt(object.sentAt, 10);
                    else if (typeof object.sentAt === "number")
                        message.sentAt = object.sentAt;
                    else if (typeof object.sentAt === "object")
                        message.sentAt = new $util.LongBits(object.sentAt.low >>> 0, object.sentAt.high >>> 0).toNumber();
            if (object.text != null) {
                if (!$util.isObject(object.text))
                    throw $TypeError(".canari.AppMessage.text: object expected");
                message.text = $root.canari.TextMsg.fromObject(object.text, _depth + 1);
            }
            if (object.reply != null) {
                if (!$util.isObject(object.reply))
                    throw $TypeError(".canari.AppMessage.reply: object expected");
                message.reply = $root.canari.ReplyMsg.fromObject(object.reply, _depth + 1);
            }
            if (object.reaction != null) {
                if (!$util.isObject(object.reaction))
                    throw $TypeError(".canari.AppMessage.reaction: object expected");
                message.reaction = $root.canari.ReactionMsg.fromObject(object.reaction, _depth + 1);
            }
            if (object.media != null) {
                if (!$util.isObject(object.media))
                    throw $TypeError(".canari.AppMessage.media: object expected");
                message.media = $root.canari.MediaMsg.fromObject(object.media, _depth + 1);
            }
            if (object.system != null) {
                if (!$util.isObject(object.system))
                    throw $TypeError(".canari.AppMessage.system: object expected");
                message.system = $root.canari.SystemMsg.fromObject(object.system, _depth + 1);
            }
            if (object.call != null) {
                if (!$util.isObject(object.call))
                    throw $TypeError(".canari.AppMessage.call: object expected");
                message.call = $root.canari.CallMsg.fromObject(object.call, _depth + 1);
            }
            if (object.poll != null) {
                if (!$util.isObject(object.poll))
                    throw $TypeError(".canari.AppMessage.poll: object expected");
                message.poll = $root.canari.PollMsg.fromObject(object.poll, _depth + 1);
            }
            return message;
        };

        /**
         * Creates a plain object from an AppMessage message. Also converts values to other types if specified.
         * @function toObject
         * @memberof canari.AppMessage
         * @static
         * @param {canari.AppMessage} message AppMessage
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        AppMessage.toObject = function (message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let object = {};
            if (options.defaults) {
                object.messageId = "";
                if ($util.Long) {
                    let long = new $util.Long(0, 0, false);
                    object.sentAt = options.longs === $String ? long.toString() : options.longs === $Number ? long.toNumber() : typeof $BigInt !== "undefined" && options.longs === $BigInt ? long.toBigInt() : long;
                } else
                    object.sentAt = options.longs === $String ? "0" : typeof $BigInt !== "undefined" && options.longs === $BigInt ? $BigInt("0") : 0;
            }
            if (message.text != null && $Object.hasOwnProperty.call(message, "text")) {
                object.text = $root.canari.TextMsg.toObject(message.text, options, _depth + 1);
                if (options.oneofs)
                    object.kind = "text";
            }
            if (message.reply != null && $Object.hasOwnProperty.call(message, "reply")) {
                object.reply = $root.canari.ReplyMsg.toObject(message.reply, options, _depth + 1);
                if (options.oneofs)
                    object.kind = "reply";
            }
            if (message.reaction != null && $Object.hasOwnProperty.call(message, "reaction")) {
                object.reaction = $root.canari.ReactionMsg.toObject(message.reaction, options, _depth + 1);
                if (options.oneofs)
                    object.kind = "reaction";
            }
            if (message.media != null && $Object.hasOwnProperty.call(message, "media")) {
                object.media = $root.canari.MediaMsg.toObject(message.media, options, _depth + 1);
                if (options.oneofs)
                    object.kind = "media";
            }
            if (message.system != null && $Object.hasOwnProperty.call(message, "system")) {
                object.system = $root.canari.SystemMsg.toObject(message.system, options, _depth + 1);
                if (options.oneofs)
                    object.kind = "system";
            }
            if (message.messageId != null && $Object.hasOwnProperty.call(message, "messageId"))
                object.messageId = message.messageId;
            if (message.call != null && $Object.hasOwnProperty.call(message, "call")) {
                object.call = $root.canari.CallMsg.toObject(message.call, options, _depth + 1);
                if (options.oneofs)
                    object.kind = "call";
            }
            if (message.sentAt != null && $Object.hasOwnProperty.call(message, "sentAt"))
                if (typeof $BigInt !== "undefined" && options.longs === $BigInt)
                    object.sentAt = typeof message.sentAt === "number" ? $BigInt(message.sentAt) : $util.Long.fromBits(message.sentAt.low >>> 0, message.sentAt.high >>> 0, false).toBigInt();
                else if (typeof message.sentAt === "number")
                    object.sentAt = options.longs === $String ? $String(message.sentAt) : message.sentAt;
                else
                    object.sentAt = options.longs === $String ? $util.Long.prototype.toString.call(message.sentAt) : options.longs === $Number ? new $util.LongBits(message.sentAt.low >>> 0, message.sentAt.high >>> 0).toNumber() : message.sentAt;
            if (message.poll != null && $Object.hasOwnProperty.call(message, "poll")) {
                object.poll = $root.canari.PollMsg.toObject(message.poll, options, _depth + 1);
                if (options.oneofs)
                    object.kind = "poll";
            }
            return object;
        };

        /**
         * Converts this AppMessage to JSON.
         * @function toJSON
         * @memberof canari.AppMessage
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        AppMessage.prototype.toJSON = function() {
            return AppMessage.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for AppMessage
         * @function getTypeUrl
         * @memberof canari.AppMessage
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        AppMessage.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/canari.AppMessage";
        };

        var C = AppMessage;

        return AppMessage;
    })();

    canari.CallMsg = (function() {

        /**
         * Properties of a CallMsg.
         * @typedef {Object} canari.CallMsg.$Properties
         * @property {string|null} [callId] CallMsg callId
         * @property {boolean|null} [hasVideo] CallMsg hasVideo
         * @property {string|null} [deviceId] CallMsg deviceId
         * @property {string|null} [offerSdp] CallMsg offerSdp
         * @property {string|null} [answerSdp] CallMsg answerSdp
         * @property {string|null} [iceCandidate] CallMsg iceCandidate
         * @property {boolean|null} [hangup] CallMsg hangup
         * @property {boolean|null} [answered] CallMsg answered
         * @property {"offerSdp"|"answerSdp"|"iceCandidate"|"hangup"|"answered"} [payload] CallMsg payload
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of a CallMsg.
         * @memberof canari
         * @interface ICallMsg
         * @augments canari.CallMsg.$Properties
         * @deprecated Use canari.CallMsg.$Properties instead.
         */

        /**
         * Narrowed shape of a CallMsg.
         * @typedef {{
         *   callId?: string|null;
         *   hasVideo?: boolean|null;
         *   deviceId?: string|null;
         *   offerSdp?: string|null;
         *   answerSdp?: string|null;
         *   iceCandidate?: string|null;
         *   hangup?: boolean|null;
         *   answered?: boolean|null;
         *   $unknowns?: Array.<Uint8Array>;
         * } & (
         *   ({ payload?: undefined; offerSdp?: null; answerSdp?: null; iceCandidate?: null; hangup?: null; answered?: null }|{ payload?: "offerSdp"; offerSdp: string; answerSdp?: null; iceCandidate?: null; hangup?: null; answered?: null }|{ payload?: "answerSdp"; offerSdp?: null; answerSdp: string; iceCandidate?: null; hangup?: null; answered?: null }|{ payload?: "iceCandidate"; offerSdp?: null; answerSdp?: null; iceCandidate: string; hangup?: null; answered?: null }|{ payload?: "hangup"; offerSdp?: null; answerSdp?: null; iceCandidate?: null; hangup: boolean; answered?: null }|{ payload?: "answered"; offerSdp?: null; answerSdp?: null; iceCandidate?: null; hangup?: null; answered: boolean })
         * )} canari.CallMsg.$Shape
         */

        /**
         * Constructs a new CallMsg.
         * @memberof canari
         * @classdesc Represents a CallMsg.
         * @constructor
         * @param {canari.CallMsg.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        const CallMsg = function (properties) {
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        /**
         * CallMsg callId.
         * @member {string} callId
         * @memberof canari.CallMsg
         * @instance
         */
        CallMsg.prototype.callId = "";

        /**
         * CallMsg hasVideo.
         * @member {boolean} hasVideo
         * @memberof canari.CallMsg
         * @instance
         */
        CallMsg.prototype.hasVideo = false;

        /**
         * CallMsg deviceId.
         * @member {string} deviceId
         * @memberof canari.CallMsg
         * @instance
         */
        CallMsg.prototype.deviceId = "";

        /**
         * CallMsg offerSdp.
         * @member {string|null|undefined} offerSdp
         * @memberof canari.CallMsg
         * @instance
         */
        CallMsg.prototype.offerSdp = null;

        /**
         * CallMsg answerSdp.
         * @member {string|null|undefined} answerSdp
         * @memberof canari.CallMsg
         * @instance
         */
        CallMsg.prototype.answerSdp = null;

        /**
         * CallMsg iceCandidate.
         * @member {string|null|undefined} iceCandidate
         * @memberof canari.CallMsg
         * @instance
         */
        CallMsg.prototype.iceCandidate = null;

        /**
         * CallMsg hangup.
         * @member {boolean|null|undefined} hangup
         * @memberof canari.CallMsg
         * @instance
         */
        CallMsg.prototype.hangup = null;

        /**
         * CallMsg answered.
         * @member {boolean|null|undefined} answered
         * @memberof canari.CallMsg
         * @instance
         */
        CallMsg.prototype.answered = null;

        // OneOf field names bound to virtual getters and setters
        let $oneOfFields;

        /**
         * CallMsg payload.
         * @member {"offerSdp"|"answerSdp"|"iceCandidate"|"hangup"|"answered"|undefined} payload
         * @memberof canari.CallMsg
         * @instance
         */
        $Object.defineProperty(CallMsg.prototype, "payload", {
            get: $util.oneOfGetter($oneOfFields = ["offerSdp", "answerSdp", "iceCandidate", "hangup", "answered"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        /**
         * Creates a new CallMsg instance using the specified properties.
         * @function create
         * @memberof canari.CallMsg
         * @static
         * @param {canari.CallMsg.$Properties=} [properties] Properties to set
         * @returns {canari.CallMsg} CallMsg instance
         * @type {{
         *   (properties: canari.CallMsg.$Shape): canari.CallMsg & canari.CallMsg.$Shape;
         *   (properties?: canari.CallMsg.$Properties): canari.CallMsg;
         * }}
         */
        CallMsg.create = function(properties) {
            return new CallMsg(properties);
        };

        /**
         * Encodes the specified CallMsg message. Does not implicitly {@link canari.CallMsg.verify|verify} messages.
         * @function encode
         * @memberof canari.CallMsg
         * @static
         * @param {canari.CallMsg.$Properties} message CallMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        CallMsg.encode = function (message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            if (message.callId != null && $Object.hasOwnProperty.call(message, "callId"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.callId);
            if (message.offerSdp != null && $Object.hasOwnProperty.call(message, "offerSdp"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.offerSdp);
            if (message.answerSdp != null && $Object.hasOwnProperty.call(message, "answerSdp"))
                writer.uint32(/* id 3, wireType 2 =*/26).string(message.answerSdp);
            if (message.iceCandidate != null && $Object.hasOwnProperty.call(message, "iceCandidate"))
                writer.uint32(/* id 4, wireType 2 =*/34).string(message.iceCandidate);
            if (message.hangup != null && $Object.hasOwnProperty.call(message, "hangup"))
                writer.uint32(/* id 5, wireType 0 =*/40).bool(message.hangup);
            if (message.hasVideo != null && $Object.hasOwnProperty.call(message, "hasVideo"))
                writer.uint32(/* id 6, wireType 0 =*/48).bool(message.hasVideo);
            if (message.answered != null && $Object.hasOwnProperty.call(message, "answered"))
                writer.uint32(/* id 7, wireType 0 =*/56).bool(message.answered);
            if (message.deviceId != null && $Object.hasOwnProperty.call(message, "deviceId"))
                writer.uint32(/* id 8, wireType 2 =*/66).string(message.deviceId);
            if (message.$unknowns != null && $Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified CallMsg message, length delimited. Does not implicitly {@link canari.CallMsg.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.CallMsg
         * @static
         * @param {canari.CallMsg.$Properties} message CallMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        CallMsg.encodeDelimited = function(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes a CallMsg message from the specified reader or buffer.
         * @function decode
         * @memberof canari.CallMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.CallMsg & canari.CallMsg.$Shape} CallMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        CallMsg.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end = length === $undefined ? reader.len : reader.pos + length, message = _target || new $root.canari.CallMsg(), value;
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.callId = value;
                        else
                            delete message.callId;
                        continue;
                    }
                case 6: {
                        if (wireType !== 0)
                            break;
                        if (value = reader.bool())
                            message.hasVideo = value;
                        else
                            delete message.hasVideo;
                        continue;
                    }
                case 8: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.deviceId = value;
                        else
                            delete message.deviceId;
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        message.offerSdp = reader.string();
                        message.payload = "offerSdp";
                        continue;
                    }
                case 3: {
                        if (wireType !== 2)
                            break;
                        message.answerSdp = reader.string();
                        message.payload = "answerSdp";
                        continue;
                    }
                case 4: {
                        if (wireType !== 2)
                            break;
                        message.iceCandidate = reader.string();
                        message.payload = "iceCandidate";
                        continue;
                    }
                case 5: {
                        if (wireType !== 0)
                            break;
                        message.hangup = reader.bool();
                        message.payload = "hangup";
                        continue;
                    }
                case 7: {
                        if (wireType !== 0)
                            break;
                        message.answered = reader.bool();
                        message.payload = "answered";
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            return message;
        };

        /**
         * Decodes a CallMsg message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.CallMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.CallMsg & canari.CallMsg.$Shape} CallMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        CallMsg.decodeDelimited = function(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a CallMsg message.
         * @function verify
         * @memberof canari.CallMsg
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        CallMsg.verify = function (message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            let properties = {};
            if (message.callId != null && $Object.hasOwnProperty.call(message, "callId"))
                if (!$util.isString(message.callId))
                    return "callId: string expected";
            if (message.hasVideo != null && $Object.hasOwnProperty.call(message, "hasVideo"))
                if (typeof message.hasVideo !== "boolean")
                    return "hasVideo: boolean expected";
            if (message.deviceId != null && $Object.hasOwnProperty.call(message, "deviceId"))
                if (!$util.isString(message.deviceId))
                    return "deviceId: string expected";
            if (message.offerSdp != null && $Object.hasOwnProperty.call(message, "offerSdp")) {
                properties.payload = 1;
                if (!$util.isString(message.offerSdp))
                    return "offerSdp: string expected";
            }
            if (message.answerSdp != null && $Object.hasOwnProperty.call(message, "answerSdp")) {
                if (properties.payload === 1)
                    return "payload: multiple values";
                properties.payload = 1;
                if (!$util.isString(message.answerSdp))
                    return "answerSdp: string expected";
            }
            if (message.iceCandidate != null && $Object.hasOwnProperty.call(message, "iceCandidate")) {
                if (properties.payload === 1)
                    return "payload: multiple values";
                properties.payload = 1;
                if (!$util.isString(message.iceCandidate))
                    return "iceCandidate: string expected";
            }
            if (message.hangup != null && $Object.hasOwnProperty.call(message, "hangup")) {
                if (properties.payload === 1)
                    return "payload: multiple values";
                properties.payload = 1;
                if (typeof message.hangup !== "boolean")
                    return "hangup: boolean expected";
            }
            if (message.answered != null && $Object.hasOwnProperty.call(message, "answered")) {
                if (properties.payload === 1)
                    return "payload: multiple values";
                properties.payload = 1;
                if (typeof message.answered !== "boolean")
                    return "answered: boolean expected";
            }
            return null;
        };

        /**
         * Creates a CallMsg message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof canari.CallMsg
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {canari.CallMsg} CallMsg
         */
        CallMsg.fromObject = function (object, _depth) {
            if (object instanceof $root.canari.CallMsg)
                return object;
            if (!$util.isObject(object))
                throw $TypeError(".canari.CallMsg: object expected");
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let message = new $root.canari.CallMsg();
            if (object.callId != null)
                if (typeof object.callId !== "string" || object.callId.length)
                    message.callId = $String(object.callId);
            if (object.hasVideo != null)
                if (object.hasVideo)
                    message.hasVideo = $Boolean(object.hasVideo);
            if (object.deviceId != null)
                if (typeof object.deviceId !== "string" || object.deviceId.length)
                    message.deviceId = $String(object.deviceId);
            if (object.offerSdp != null)
                message.offerSdp = $String(object.offerSdp);
            if (object.answerSdp != null)
                message.answerSdp = $String(object.answerSdp);
            if (object.iceCandidate != null)
                message.iceCandidate = $String(object.iceCandidate);
            if (object.hangup != null)
                message.hangup = $Boolean(object.hangup);
            if (object.answered != null)
                message.answered = $Boolean(object.answered);
            return message;
        };

        /**
         * Creates a plain object from a CallMsg message. Also converts values to other types if specified.
         * @function toObject
         * @memberof canari.CallMsg
         * @static
         * @param {canari.CallMsg} message CallMsg
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        CallMsg.toObject = function (message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let object = {};
            if (options.defaults) {
                object.callId = "";
                object.hasVideo = false;
                object.deviceId = "";
            }
            if (message.callId != null && $Object.hasOwnProperty.call(message, "callId"))
                object.callId = message.callId;
            if (message.offerSdp != null && $Object.hasOwnProperty.call(message, "offerSdp")) {
                object.offerSdp = message.offerSdp;
                if (options.oneofs)
                    object.payload = "offerSdp";
            }
            if (message.answerSdp != null && $Object.hasOwnProperty.call(message, "answerSdp")) {
                object.answerSdp = message.answerSdp;
                if (options.oneofs)
                    object.payload = "answerSdp";
            }
            if (message.iceCandidate != null && $Object.hasOwnProperty.call(message, "iceCandidate")) {
                object.iceCandidate = message.iceCandidate;
                if (options.oneofs)
                    object.payload = "iceCandidate";
            }
            if (message.hangup != null && $Object.hasOwnProperty.call(message, "hangup")) {
                object.hangup = message.hangup;
                if (options.oneofs)
                    object.payload = "hangup";
            }
            if (message.hasVideo != null && $Object.hasOwnProperty.call(message, "hasVideo"))
                object.hasVideo = message.hasVideo;
            if (message.answered != null && $Object.hasOwnProperty.call(message, "answered")) {
                object.answered = message.answered;
                if (options.oneofs)
                    object.payload = "answered";
            }
            if (message.deviceId != null && $Object.hasOwnProperty.call(message, "deviceId"))
                object.deviceId = message.deviceId;
            return object;
        };

        /**
         * Converts this CallMsg to JSON.
         * @function toJSON
         * @memberof canari.CallMsg
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        CallMsg.prototype.toJSON = function() {
            return CallMsg.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for CallMsg
         * @function getTypeUrl
         * @memberof canari.CallMsg
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        CallMsg.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/canari.CallMsg";
        };

        var C = CallMsg;

        return CallMsg;
    })();

    canari.TextMsg = (function() {

        /**
         * Properties of a TextMsg.
         * @typedef {Object} canari.TextMsg.$Properties
         * @property {string|null} [content] TextMsg content
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of a TextMsg.
         * @memberof canari
         * @interface ITextMsg
         * @augments canari.TextMsg.$Properties
         * @deprecated Use canari.TextMsg.$Properties instead.
         */

        /**
         * Shape of a TextMsg.
         * @typedef {canari.TextMsg.$Properties} canari.TextMsg.$Shape
         */

        /**
         * Constructs a new TextMsg.
         * @memberof canari
         * @classdesc Represents a TextMsg.
         * @constructor
         * @param {canari.TextMsg.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        const TextMsg = function (properties) {
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        /**
         * TextMsg content.
         * @member {string} content
         * @memberof canari.TextMsg
         * @instance
         */
        TextMsg.prototype.content = "";

        /**
         * Creates a new TextMsg instance using the specified properties.
         * @function create
         * @memberof canari.TextMsg
         * @static
         * @param {canari.TextMsg.$Properties=} [properties] Properties to set
         * @returns {canari.TextMsg} TextMsg instance
         * @type {{
         *   (properties: canari.TextMsg.$Shape): canari.TextMsg & canari.TextMsg.$Shape;
         *   (properties?: canari.TextMsg.$Properties): canari.TextMsg;
         * }}
         */
        TextMsg.create = function(properties) {
            return new TextMsg(properties);
        };

        /**
         * Encodes the specified TextMsg message. Does not implicitly {@link canari.TextMsg.verify|verify} messages.
         * @function encode
         * @memberof canari.TextMsg
         * @static
         * @param {canari.TextMsg.$Properties} message TextMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        TextMsg.encode = function (message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            if (message.content != null && $Object.hasOwnProperty.call(message, "content"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.content);
            if (message.$unknowns != null && $Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified TextMsg message, length delimited. Does not implicitly {@link canari.TextMsg.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.TextMsg
         * @static
         * @param {canari.TextMsg.$Properties} message TextMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        TextMsg.encodeDelimited = function(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes a TextMsg message from the specified reader or buffer.
         * @function decode
         * @memberof canari.TextMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.TextMsg & canari.TextMsg.$Shape} TextMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        TextMsg.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end = length === $undefined ? reader.len : reader.pos + length, message = _target || new $root.canari.TextMsg(), value;
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.content = value;
                        else
                            delete message.content;
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            return message;
        };

        /**
         * Decodes a TextMsg message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.TextMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.TextMsg & canari.TextMsg.$Shape} TextMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        TextMsg.decodeDelimited = function(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a TextMsg message.
         * @function verify
         * @memberof canari.TextMsg
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        TextMsg.verify = function (message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.content != null && $Object.hasOwnProperty.call(message, "content"))
                if (!$util.isString(message.content))
                    return "content: string expected";
            return null;
        };

        /**
         * Creates a TextMsg message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof canari.TextMsg
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {canari.TextMsg} TextMsg
         */
        TextMsg.fromObject = function (object, _depth) {
            if (object instanceof $root.canari.TextMsg)
                return object;
            if (!$util.isObject(object))
                throw $TypeError(".canari.TextMsg: object expected");
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let message = new $root.canari.TextMsg();
            if (object.content != null)
                if (typeof object.content !== "string" || object.content.length)
                    message.content = $String(object.content);
            return message;
        };

        /**
         * Creates a plain object from a TextMsg message. Also converts values to other types if specified.
         * @function toObject
         * @memberof canari.TextMsg
         * @static
         * @param {canari.TextMsg} message TextMsg
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        TextMsg.toObject = function (message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let object = {};
            if (options.defaults)
                object.content = "";
            if (message.content != null && $Object.hasOwnProperty.call(message, "content"))
                object.content = message.content;
            return object;
        };

        /**
         * Converts this TextMsg to JSON.
         * @function toJSON
         * @memberof canari.TextMsg
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        TextMsg.prototype.toJSON = function() {
            return TextMsg.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for TextMsg
         * @function getTypeUrl
         * @memberof canari.TextMsg
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        TextMsg.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/canari.TextMsg";
        };

        var C = TextMsg;

        return TextMsg;
    })();

    canari.ReplyRef = (function() {

        /**
         * Properties of a ReplyRef.
         * @typedef {Object} canari.ReplyRef.$Properties
         * @property {string|null} [id] ReplyRef id
         * @property {string|null} [senderId] ReplyRef senderId
         * @property {string|null} [preview] ReplyRef preview
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of a ReplyRef.
         * @memberof canari
         * @interface IReplyRef
         * @augments canari.ReplyRef.$Properties
         * @deprecated Use canari.ReplyRef.$Properties instead.
         */

        /**
         * Shape of a ReplyRef.
         * @typedef {canari.ReplyRef.$Properties} canari.ReplyRef.$Shape
         */

        /**
         * Constructs a new ReplyRef.
         * @memberof canari
         * @classdesc Represents a ReplyRef.
         * @constructor
         * @param {canari.ReplyRef.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        const ReplyRef = function (properties) {
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        /**
         * ReplyRef id.
         * @member {string} id
         * @memberof canari.ReplyRef
         * @instance
         */
        ReplyRef.prototype.id = "";

        /**
         * ReplyRef senderId.
         * @member {string} senderId
         * @memberof canari.ReplyRef
         * @instance
         */
        ReplyRef.prototype.senderId = "";

        /**
         * ReplyRef preview.
         * @member {string} preview
         * @memberof canari.ReplyRef
         * @instance
         */
        ReplyRef.prototype.preview = "";

        /**
         * Creates a new ReplyRef instance using the specified properties.
         * @function create
         * @memberof canari.ReplyRef
         * @static
         * @param {canari.ReplyRef.$Properties=} [properties] Properties to set
         * @returns {canari.ReplyRef} ReplyRef instance
         * @type {{
         *   (properties: canari.ReplyRef.$Shape): canari.ReplyRef & canari.ReplyRef.$Shape;
         *   (properties?: canari.ReplyRef.$Properties): canari.ReplyRef;
         * }}
         */
        ReplyRef.create = function(properties) {
            return new ReplyRef(properties);
        };

        /**
         * Encodes the specified ReplyRef message. Does not implicitly {@link canari.ReplyRef.verify|verify} messages.
         * @function encode
         * @memberof canari.ReplyRef
         * @static
         * @param {canari.ReplyRef.$Properties} message ReplyRef message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        ReplyRef.encode = function (message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            if (message.id != null && $Object.hasOwnProperty.call(message, "id"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.id);
            if (message.senderId != null && $Object.hasOwnProperty.call(message, "senderId"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.senderId);
            if (message.preview != null && $Object.hasOwnProperty.call(message, "preview"))
                writer.uint32(/* id 3, wireType 2 =*/26).string(message.preview);
            if (message.$unknowns != null && $Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified ReplyRef message, length delimited. Does not implicitly {@link canari.ReplyRef.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.ReplyRef
         * @static
         * @param {canari.ReplyRef.$Properties} message ReplyRef message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        ReplyRef.encodeDelimited = function(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes a ReplyRef message from the specified reader or buffer.
         * @function decode
         * @memberof canari.ReplyRef
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.ReplyRef & canari.ReplyRef.$Shape} ReplyRef
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        ReplyRef.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end = length === $undefined ? reader.len : reader.pos + length, message = _target || new $root.canari.ReplyRef(), value;
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.id = value;
                        else
                            delete message.id;
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.senderId = value;
                        else
                            delete message.senderId;
                        continue;
                    }
                case 3: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.preview = value;
                        else
                            delete message.preview;
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            return message;
        };

        /**
         * Decodes a ReplyRef message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.ReplyRef
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.ReplyRef & canari.ReplyRef.$Shape} ReplyRef
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        ReplyRef.decodeDelimited = function(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a ReplyRef message.
         * @function verify
         * @memberof canari.ReplyRef
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        ReplyRef.verify = function (message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.id != null && $Object.hasOwnProperty.call(message, "id"))
                if (!$util.isString(message.id))
                    return "id: string expected";
            if (message.senderId != null && $Object.hasOwnProperty.call(message, "senderId"))
                if (!$util.isString(message.senderId))
                    return "senderId: string expected";
            if (message.preview != null && $Object.hasOwnProperty.call(message, "preview"))
                if (!$util.isString(message.preview))
                    return "preview: string expected";
            return null;
        };

        /**
         * Creates a ReplyRef message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof canari.ReplyRef
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {canari.ReplyRef} ReplyRef
         */
        ReplyRef.fromObject = function (object, _depth) {
            if (object instanceof $root.canari.ReplyRef)
                return object;
            if (!$util.isObject(object))
                throw $TypeError(".canari.ReplyRef: object expected");
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let message = new $root.canari.ReplyRef();
            if (object.id != null)
                if (typeof object.id !== "string" || object.id.length)
                    message.id = $String(object.id);
            if (object.senderId != null)
                if (typeof object.senderId !== "string" || object.senderId.length)
                    message.senderId = $String(object.senderId);
            if (object.preview != null)
                if (typeof object.preview !== "string" || object.preview.length)
                    message.preview = $String(object.preview);
            return message;
        };

        /**
         * Creates a plain object from a ReplyRef message. Also converts values to other types if specified.
         * @function toObject
         * @memberof canari.ReplyRef
         * @static
         * @param {canari.ReplyRef} message ReplyRef
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        ReplyRef.toObject = function (message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let object = {};
            if (options.defaults) {
                object.id = "";
                object.senderId = "";
                object.preview = "";
            }
            if (message.id != null && $Object.hasOwnProperty.call(message, "id"))
                object.id = message.id;
            if (message.senderId != null && $Object.hasOwnProperty.call(message, "senderId"))
                object.senderId = message.senderId;
            if (message.preview != null && $Object.hasOwnProperty.call(message, "preview"))
                object.preview = message.preview;
            return object;
        };

        /**
         * Converts this ReplyRef to JSON.
         * @function toJSON
         * @memberof canari.ReplyRef
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        ReplyRef.prototype.toJSON = function() {
            return ReplyRef.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for ReplyRef
         * @function getTypeUrl
         * @memberof canari.ReplyRef
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        ReplyRef.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/canari.ReplyRef";
        };

        var C = ReplyRef;

        return ReplyRef;
    })();

    canari.ReplyMsg = (function() {

        /**
         * Properties of a ReplyMsg.
         * @typedef {Object} canari.ReplyMsg.$Properties
         * @property {string|null} [content] ReplyMsg content
         * @property {canari.ReplyRef.$Properties|null} [replyTo] ReplyMsg replyTo
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of a ReplyMsg.
         * @memberof canari
         * @interface IReplyMsg
         * @augments canari.ReplyMsg.$Properties
         * @deprecated Use canari.ReplyMsg.$Properties instead.
         */

        /**
         * Shape of a ReplyMsg.
         * @typedef {canari.ReplyMsg.$Properties} canari.ReplyMsg.$Shape
         */

        /**
         * Constructs a new ReplyMsg.
         * @memberof canari
         * @classdesc Represents a ReplyMsg.
         * @constructor
         * @param {canari.ReplyMsg.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        const ReplyMsg = function (properties) {
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        /**
         * ReplyMsg content.
         * @member {string} content
         * @memberof canari.ReplyMsg
         * @instance
         */
        ReplyMsg.prototype.content = "";

        /**
         * ReplyMsg replyTo.
         * @member {canari.ReplyRef.$Properties|null|undefined} replyTo
         * @memberof canari.ReplyMsg
         * @instance
         */
        ReplyMsg.prototype.replyTo = null;

        /**
         * Creates a new ReplyMsg instance using the specified properties.
         * @function create
         * @memberof canari.ReplyMsg
         * @static
         * @param {canari.ReplyMsg.$Properties=} [properties] Properties to set
         * @returns {canari.ReplyMsg} ReplyMsg instance
         * @type {{
         *   (properties: canari.ReplyMsg.$Shape): canari.ReplyMsg & canari.ReplyMsg.$Shape;
         *   (properties?: canari.ReplyMsg.$Properties): canari.ReplyMsg;
         * }}
         */
        ReplyMsg.create = function(properties) {
            return new ReplyMsg(properties);
        };

        /**
         * Encodes the specified ReplyMsg message. Does not implicitly {@link canari.ReplyMsg.verify|verify} messages.
         * @function encode
         * @memberof canari.ReplyMsg
         * @static
         * @param {canari.ReplyMsg.$Properties} message ReplyMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        ReplyMsg.encode = function (message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            if (message.content != null && $Object.hasOwnProperty.call(message, "content"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.content);
            if (message.replyTo != null && $Object.hasOwnProperty.call(message, "replyTo"))
                $root.canari.ReplyRef.encode(message.replyTo, writer.uint32(/* id 2, wireType 2 =*/18).fork(), _depth + 1).ldelim();
            if (message.$unknowns != null && $Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified ReplyMsg message, length delimited. Does not implicitly {@link canari.ReplyMsg.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.ReplyMsg
         * @static
         * @param {canari.ReplyMsg.$Properties} message ReplyMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        ReplyMsg.encodeDelimited = function(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes a ReplyMsg message from the specified reader or buffer.
         * @function decode
         * @memberof canari.ReplyMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.ReplyMsg & canari.ReplyMsg.$Shape} ReplyMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        ReplyMsg.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end = length === $undefined ? reader.len : reader.pos + length, message = _target || new $root.canari.ReplyMsg(), value;
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.content = value;
                        else
                            delete message.content;
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        message.replyTo = $root.canari.ReplyRef.decode(reader, reader.uint32(), $undefined, _depth + 1, message.replyTo);
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            return message;
        };

        /**
         * Decodes a ReplyMsg message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.ReplyMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.ReplyMsg & canari.ReplyMsg.$Shape} ReplyMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        ReplyMsg.decodeDelimited = function(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a ReplyMsg message.
         * @function verify
         * @memberof canari.ReplyMsg
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        ReplyMsg.verify = function (message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.content != null && $Object.hasOwnProperty.call(message, "content"))
                if (!$util.isString(message.content))
                    return "content: string expected";
            if (message.replyTo != null && $Object.hasOwnProperty.call(message, "replyTo")) {
                let error = $root.canari.ReplyRef.verify(message.replyTo, _depth + 1);
                if (error)
                    return "replyTo." + error;
            }
            return null;
        };

        /**
         * Creates a ReplyMsg message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof canari.ReplyMsg
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {canari.ReplyMsg} ReplyMsg
         */
        ReplyMsg.fromObject = function (object, _depth) {
            if (object instanceof $root.canari.ReplyMsg)
                return object;
            if (!$util.isObject(object))
                throw $TypeError(".canari.ReplyMsg: object expected");
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let message = new $root.canari.ReplyMsg();
            if (object.content != null)
                if (typeof object.content !== "string" || object.content.length)
                    message.content = $String(object.content);
            if (object.replyTo != null) {
                if (!$util.isObject(object.replyTo))
                    throw $TypeError(".canari.ReplyMsg.replyTo: object expected");
                message.replyTo = $root.canari.ReplyRef.fromObject(object.replyTo, _depth + 1);
            }
            return message;
        };

        /**
         * Creates a plain object from a ReplyMsg message. Also converts values to other types if specified.
         * @function toObject
         * @memberof canari.ReplyMsg
         * @static
         * @param {canari.ReplyMsg} message ReplyMsg
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        ReplyMsg.toObject = function (message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let object = {};
            if (options.defaults) {
                object.content = "";
                object.replyTo = null;
            }
            if (message.content != null && $Object.hasOwnProperty.call(message, "content"))
                object.content = message.content;
            if (message.replyTo != null && $Object.hasOwnProperty.call(message, "replyTo"))
                object.replyTo = $root.canari.ReplyRef.toObject(message.replyTo, options, _depth + 1);
            return object;
        };

        /**
         * Converts this ReplyMsg to JSON.
         * @function toJSON
         * @memberof canari.ReplyMsg
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        ReplyMsg.prototype.toJSON = function() {
            return ReplyMsg.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for ReplyMsg
         * @function getTypeUrl
         * @memberof canari.ReplyMsg
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        ReplyMsg.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/canari.ReplyMsg";
        };

        var C = ReplyMsg;

        return ReplyMsg;
    })();

    canari.ReactionMsg = (function() {

        /**
         * Properties of a ReactionMsg.
         * @typedef {Object} canari.ReactionMsg.$Properties
         * @property {string|null} [messageId] ReactionMsg messageId
         * @property {string|null} [emoji] ReactionMsg emoji
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of a ReactionMsg.
         * @memberof canari
         * @interface IReactionMsg
         * @augments canari.ReactionMsg.$Properties
         * @deprecated Use canari.ReactionMsg.$Properties instead.
         */

        /**
         * Shape of a ReactionMsg.
         * @typedef {canari.ReactionMsg.$Properties} canari.ReactionMsg.$Shape
         */

        /**
         * Constructs a new ReactionMsg.
         * @memberof canari
         * @classdesc Represents a ReactionMsg.
         * @constructor
         * @param {canari.ReactionMsg.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        const ReactionMsg = function (properties) {
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        /**
         * ReactionMsg messageId.
         * @member {string} messageId
         * @memberof canari.ReactionMsg
         * @instance
         */
        ReactionMsg.prototype.messageId = "";

        /**
         * ReactionMsg emoji.
         * @member {string} emoji
         * @memberof canari.ReactionMsg
         * @instance
         */
        ReactionMsg.prototype.emoji = "";

        /**
         * Creates a new ReactionMsg instance using the specified properties.
         * @function create
         * @memberof canari.ReactionMsg
         * @static
         * @param {canari.ReactionMsg.$Properties=} [properties] Properties to set
         * @returns {canari.ReactionMsg} ReactionMsg instance
         * @type {{
         *   (properties: canari.ReactionMsg.$Shape): canari.ReactionMsg & canari.ReactionMsg.$Shape;
         *   (properties?: canari.ReactionMsg.$Properties): canari.ReactionMsg;
         * }}
         */
        ReactionMsg.create = function(properties) {
            return new ReactionMsg(properties);
        };

        /**
         * Encodes the specified ReactionMsg message. Does not implicitly {@link canari.ReactionMsg.verify|verify} messages.
         * @function encode
         * @memberof canari.ReactionMsg
         * @static
         * @param {canari.ReactionMsg.$Properties} message ReactionMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        ReactionMsg.encode = function (message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            if (message.messageId != null && $Object.hasOwnProperty.call(message, "messageId"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.messageId);
            if (message.emoji != null && $Object.hasOwnProperty.call(message, "emoji"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.emoji);
            if (message.$unknowns != null && $Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified ReactionMsg message, length delimited. Does not implicitly {@link canari.ReactionMsg.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.ReactionMsg
         * @static
         * @param {canari.ReactionMsg.$Properties} message ReactionMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        ReactionMsg.encodeDelimited = function(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes a ReactionMsg message from the specified reader or buffer.
         * @function decode
         * @memberof canari.ReactionMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.ReactionMsg & canari.ReactionMsg.$Shape} ReactionMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        ReactionMsg.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end = length === $undefined ? reader.len : reader.pos + length, message = _target || new $root.canari.ReactionMsg(), value;
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.messageId = value;
                        else
                            delete message.messageId;
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.emoji = value;
                        else
                            delete message.emoji;
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            return message;
        };

        /**
         * Decodes a ReactionMsg message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.ReactionMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.ReactionMsg & canari.ReactionMsg.$Shape} ReactionMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        ReactionMsg.decodeDelimited = function(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a ReactionMsg message.
         * @function verify
         * @memberof canari.ReactionMsg
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        ReactionMsg.verify = function (message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.messageId != null && $Object.hasOwnProperty.call(message, "messageId"))
                if (!$util.isString(message.messageId))
                    return "messageId: string expected";
            if (message.emoji != null && $Object.hasOwnProperty.call(message, "emoji"))
                if (!$util.isString(message.emoji))
                    return "emoji: string expected";
            return null;
        };

        /**
         * Creates a ReactionMsg message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof canari.ReactionMsg
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {canari.ReactionMsg} ReactionMsg
         */
        ReactionMsg.fromObject = function (object, _depth) {
            if (object instanceof $root.canari.ReactionMsg)
                return object;
            if (!$util.isObject(object))
                throw $TypeError(".canari.ReactionMsg: object expected");
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let message = new $root.canari.ReactionMsg();
            if (object.messageId != null)
                if (typeof object.messageId !== "string" || object.messageId.length)
                    message.messageId = $String(object.messageId);
            if (object.emoji != null)
                if (typeof object.emoji !== "string" || object.emoji.length)
                    message.emoji = $String(object.emoji);
            return message;
        };

        /**
         * Creates a plain object from a ReactionMsg message. Also converts values to other types if specified.
         * @function toObject
         * @memberof canari.ReactionMsg
         * @static
         * @param {canari.ReactionMsg} message ReactionMsg
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        ReactionMsg.toObject = function (message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let object = {};
            if (options.defaults) {
                object.messageId = "";
                object.emoji = "";
            }
            if (message.messageId != null && $Object.hasOwnProperty.call(message, "messageId"))
                object.messageId = message.messageId;
            if (message.emoji != null && $Object.hasOwnProperty.call(message, "emoji"))
                object.emoji = message.emoji;
            return object;
        };

        /**
         * Converts this ReactionMsg to JSON.
         * @function toJSON
         * @memberof canari.ReactionMsg
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        ReactionMsg.prototype.toJSON = function() {
            return ReactionMsg.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for ReactionMsg
         * @function getTypeUrl
         * @memberof canari.ReactionMsg
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        ReactionMsg.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/canari.ReactionMsg";
        };

        var C = ReactionMsg;

        return ReactionMsg;
    })();

    canari.PollOption = (function() {

        /**
         * Properties of a PollOption.
         * @typedef {Object} canari.PollOption.$Properties
         * @property {string|null} [id] PollOption id
         * @property {string|null} [label] PollOption label
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of a PollOption.
         * @memberof canari
         * @interface IPollOption
         * @augments canari.PollOption.$Properties
         * @deprecated Use canari.PollOption.$Properties instead.
         */

        /**
         * Shape of a PollOption.
         * @typedef {canari.PollOption.$Properties} canari.PollOption.$Shape
         */

        /**
         * Constructs a new PollOption.
         * @memberof canari
         * @classdesc Represents a PollOption.
         * @constructor
         * @param {canari.PollOption.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        const PollOption = function (properties) {
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        /**
         * PollOption id.
         * @member {string} id
         * @memberof canari.PollOption
         * @instance
         */
        PollOption.prototype.id = "";

        /**
         * PollOption label.
         * @member {string} label
         * @memberof canari.PollOption
         * @instance
         */
        PollOption.prototype.label = "";

        /**
         * Creates a new PollOption instance using the specified properties.
         * @function create
         * @memberof canari.PollOption
         * @static
         * @param {canari.PollOption.$Properties=} [properties] Properties to set
         * @returns {canari.PollOption} PollOption instance
         * @type {{
         *   (properties: canari.PollOption.$Shape): canari.PollOption & canari.PollOption.$Shape;
         *   (properties?: canari.PollOption.$Properties): canari.PollOption;
         * }}
         */
        PollOption.create = function(properties) {
            return new PollOption(properties);
        };

        /**
         * Encodes the specified PollOption message. Does not implicitly {@link canari.PollOption.verify|verify} messages.
         * @function encode
         * @memberof canari.PollOption
         * @static
         * @param {canari.PollOption.$Properties} message PollOption message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        PollOption.encode = function (message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            if (message.id != null && $Object.hasOwnProperty.call(message, "id"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.id);
            if (message.label != null && $Object.hasOwnProperty.call(message, "label"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.label);
            if (message.$unknowns != null && $Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified PollOption message, length delimited. Does not implicitly {@link canari.PollOption.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.PollOption
         * @static
         * @param {canari.PollOption.$Properties} message PollOption message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        PollOption.encodeDelimited = function(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes a PollOption message from the specified reader or buffer.
         * @function decode
         * @memberof canari.PollOption
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.PollOption & canari.PollOption.$Shape} PollOption
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        PollOption.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end = length === $undefined ? reader.len : reader.pos + length, message = _target || new $root.canari.PollOption(), value;
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.id = value;
                        else
                            delete message.id;
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.label = value;
                        else
                            delete message.label;
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            return message;
        };

        /**
         * Decodes a PollOption message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.PollOption
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.PollOption & canari.PollOption.$Shape} PollOption
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        PollOption.decodeDelimited = function(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a PollOption message.
         * @function verify
         * @memberof canari.PollOption
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        PollOption.verify = function (message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.id != null && $Object.hasOwnProperty.call(message, "id"))
                if (!$util.isString(message.id))
                    return "id: string expected";
            if (message.label != null && $Object.hasOwnProperty.call(message, "label"))
                if (!$util.isString(message.label))
                    return "label: string expected";
            return null;
        };

        /**
         * Creates a PollOption message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof canari.PollOption
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {canari.PollOption} PollOption
         */
        PollOption.fromObject = function (object, _depth) {
            if (object instanceof $root.canari.PollOption)
                return object;
            if (!$util.isObject(object))
                throw $TypeError(".canari.PollOption: object expected");
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let message = new $root.canari.PollOption();
            if (object.id != null)
                if (typeof object.id !== "string" || object.id.length)
                    message.id = $String(object.id);
            if (object.label != null)
                if (typeof object.label !== "string" || object.label.length)
                    message.label = $String(object.label);
            return message;
        };

        /**
         * Creates a plain object from a PollOption message. Also converts values to other types if specified.
         * @function toObject
         * @memberof canari.PollOption
         * @static
         * @param {canari.PollOption} message PollOption
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        PollOption.toObject = function (message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let object = {};
            if (options.defaults) {
                object.id = "";
                object.label = "";
            }
            if (message.id != null && $Object.hasOwnProperty.call(message, "id"))
                object.id = message.id;
            if (message.label != null && $Object.hasOwnProperty.call(message, "label"))
                object.label = message.label;
            return object;
        };

        /**
         * Converts this PollOption to JSON.
         * @function toJSON
         * @memberof canari.PollOption
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        PollOption.prototype.toJSON = function() {
            return PollOption.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for PollOption
         * @function getTypeUrl
         * @memberof canari.PollOption
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        PollOption.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/canari.PollOption";
        };

        var C = PollOption;

        return PollOption;
    })();

    canari.PollMsg = (function() {

        /**
         * Properties of a PollMsg.
         * @typedef {Object} canari.PollMsg.$Properties
         * @property {string|null} [question] PollMsg question
         * @property {Array.<canari.PollOption.$Properties>|null} [options] PollMsg options
         * @property {boolean|null} [multipleChoice] PollMsg multipleChoice
         * @property {number|null} [endsAt] PollMsg endsAt
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of a PollMsg.
         * @memberof canari
         * @interface IPollMsg
         * @augments canari.PollMsg.$Properties
         * @deprecated Use canari.PollMsg.$Properties instead.
         */

        /**
         * Shape of a PollMsg.
         * @typedef {canari.PollMsg.$Properties} canari.PollMsg.$Shape
         */

        /**
         * Constructs a new PollMsg.
         * @memberof canari
         * @classdesc Represents a PollMsg.
         * @constructor
         * @param {canari.PollMsg.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        const PollMsg = function (properties) {
            this.options = [];
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        /**
         * PollMsg question.
         * @member {string} question
         * @memberof canari.PollMsg
         * @instance
         */
        PollMsg.prototype.question = "";

        /**
         * PollMsg options.
         * @member {Array.<canari.PollOption.$Properties>} options
         * @memberof canari.PollMsg
         * @instance
         */
        PollMsg.prototype.options = $util.emptyArray;

        /**
         * PollMsg multipleChoice.
         * @member {boolean} multipleChoice
         * @memberof canari.PollMsg
         * @instance
         */
        PollMsg.prototype.multipleChoice = false;

        /**
         * PollMsg endsAt.
         * @member {number} endsAt
         * @memberof canari.PollMsg
         * @instance
         */
        PollMsg.prototype.endsAt = $util.Long ? $util.Long.fromBits(0,0,false) : 0;

        /**
         * Creates a new PollMsg instance using the specified properties.
         * @function create
         * @memberof canari.PollMsg
         * @static
         * @param {canari.PollMsg.$Properties=} [properties] Properties to set
         * @returns {canari.PollMsg} PollMsg instance
         * @type {{
         *   (properties: canari.PollMsg.$Shape): canari.PollMsg & canari.PollMsg.$Shape;
         *   (properties?: canari.PollMsg.$Properties): canari.PollMsg;
         * }}
         */
        PollMsg.create = function(properties) {
            return new PollMsg(properties);
        };

        /**
         * Encodes the specified PollMsg message. Does not implicitly {@link canari.PollMsg.verify|verify} messages.
         * @function encode
         * @memberof canari.PollMsg
         * @static
         * @param {canari.PollMsg.$Properties} message PollMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        PollMsg.encode = function (message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            if (message.question != null && $Object.hasOwnProperty.call(message, "question"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.question);
            if (message.options != null && message.options.length)
                for (let i = 0; i < message.options.length; ++i)
                    $root.canari.PollOption.encode(message.options[i], writer.uint32(/* id 2, wireType 2 =*/18).fork(), _depth + 1).ldelim();
            if (message.multipleChoice != null && $Object.hasOwnProperty.call(message, "multipleChoice"))
                writer.uint32(/* id 3, wireType 0 =*/24).bool(message.multipleChoice);
            if (message.endsAt != null && $Object.hasOwnProperty.call(message, "endsAt"))
                writer.uint32(/* id 4, wireType 0 =*/32).int64(message.endsAt);
            if (message.$unknowns != null && $Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified PollMsg message, length delimited. Does not implicitly {@link canari.PollMsg.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.PollMsg
         * @static
         * @param {canari.PollMsg.$Properties} message PollMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        PollMsg.encodeDelimited = function(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes a PollMsg message from the specified reader or buffer.
         * @function decode
         * @memberof canari.PollMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.PollMsg & canari.PollMsg.$Shape} PollMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        PollMsg.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end = length === $undefined ? reader.len : reader.pos + length, message = _target || new $root.canari.PollMsg(), value;
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.question = value;
                        else
                            delete message.question;
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        if (!(message.options && message.options.length))
                            message.options = [];
                        message.options.push($root.canari.PollOption.decode(reader, reader.uint32(), $undefined, _depth + 1));
                        continue;
                    }
                case 3: {
                        if (wireType !== 0)
                            break;
                        if (value = reader.bool())
                            message.multipleChoice = value;
                        else
                            delete message.multipleChoice;
                        continue;
                    }
                case 4: {
                        if (wireType !== 0)
                            break;
                        if (typeof (value = reader.int64()) === "object" ? value.low || value.high : value !== 0)
                            message.endsAt = value;
                        else
                            delete message.endsAt;
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            return message;
        };

        /**
         * Decodes a PollMsg message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.PollMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.PollMsg & canari.PollMsg.$Shape} PollMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        PollMsg.decodeDelimited = function(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a PollMsg message.
         * @function verify
         * @memberof canari.PollMsg
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        PollMsg.verify = function (message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.question != null && $Object.hasOwnProperty.call(message, "question"))
                if (!$util.isString(message.question))
                    return "question: string expected";
            if (message.options != null && $Object.hasOwnProperty.call(message, "options")) {
                if (!$Array.isArray(message.options))
                    return "options: array expected";
                for (let i = 0; i < message.options.length; ++i) {
                    let error = $root.canari.PollOption.verify(message.options[i], _depth + 1);
                    if (error)
                        return "options." + error;
                }
            }
            if (message.multipleChoice != null && $Object.hasOwnProperty.call(message, "multipleChoice"))
                if (typeof message.multipleChoice !== "boolean")
                    return "multipleChoice: boolean expected";
            if (message.endsAt != null && $Object.hasOwnProperty.call(message, "endsAt"))
                if (!$util.isInteger(message.endsAt) && !(message.endsAt && $util.isInteger(message.endsAt.low) && $util.isInteger(message.endsAt.high)))
                    return "endsAt: integer|Long expected";
            return null;
        };

        /**
         * Creates a PollMsg message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof canari.PollMsg
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {canari.PollMsg} PollMsg
         */
        PollMsg.fromObject = function (object, _depth) {
            if (object instanceof $root.canari.PollMsg)
                return object;
            if (!$util.isObject(object))
                throw $TypeError(".canari.PollMsg: object expected");
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let message = new $root.canari.PollMsg();
            if (object.question != null)
                if (typeof object.question !== "string" || object.question.length)
                    message.question = $String(object.question);
            if (object.options) {
                if (!$Array.isArray(object.options))
                    throw $TypeError(".canari.PollMsg.options: array expected");
                message.options = $Array(object.options.length);
                for (let i = 0; i < object.options.length; ++i) {
                    if (!$util.isObject(object.options[i]))
                        throw $TypeError(".canari.PollMsg.options: object expected");
                    message.options[i] = $root.canari.PollOption.fromObject(object.options[i], _depth + 1);
                }
            }
            if (object.multipleChoice != null)
                if (object.multipleChoice)
                    message.multipleChoice = $Boolean(object.multipleChoice);
            if (object.endsAt != null)
                if (typeof object.endsAt === "object" ? object.endsAt.low || object.endsAt.high : $Number(object.endsAt) !== 0)
                    if ($util.Long)
                        message.endsAt = $util.Long.fromValue(object.endsAt, false);
                    else if (typeof object.endsAt === "string")
                        message.endsAt = $parseInt(object.endsAt, 10);
                    else if (typeof object.endsAt === "number")
                        message.endsAt = object.endsAt;
                    else if (typeof object.endsAt === "object")
                        message.endsAt = new $util.LongBits(object.endsAt.low >>> 0, object.endsAt.high >>> 0).toNumber();
            return message;
        };

        /**
         * Creates a plain object from a PollMsg message. Also converts values to other types if specified.
         * @function toObject
         * @memberof canari.PollMsg
         * @static
         * @param {canari.PollMsg} message PollMsg
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        PollMsg.toObject = function (message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let object = {};
            if (options.arrays || options.defaults)
                object.options = [];
            if (options.defaults) {
                object.question = "";
                object.multipleChoice = false;
                if ($util.Long) {
                    let long = new $util.Long(0, 0, false);
                    object.endsAt = options.longs === $String ? long.toString() : options.longs === $Number ? long.toNumber() : typeof $BigInt !== "undefined" && options.longs === $BigInt ? long.toBigInt() : long;
                } else
                    object.endsAt = options.longs === $String ? "0" : typeof $BigInt !== "undefined" && options.longs === $BigInt ? $BigInt("0") : 0;
            }
            if (message.question != null && $Object.hasOwnProperty.call(message, "question"))
                object.question = message.question;
            if (message.options && message.options.length) {
                object.options = $Array(message.options.length);
                for (let j = 0; j < message.options.length; ++j)
                    object.options[j] = $root.canari.PollOption.toObject(message.options[j], options, _depth + 1);
            }
            if (message.multipleChoice != null && $Object.hasOwnProperty.call(message, "multipleChoice"))
                object.multipleChoice = message.multipleChoice;
            if (message.endsAt != null && $Object.hasOwnProperty.call(message, "endsAt"))
                if (typeof $BigInt !== "undefined" && options.longs === $BigInt)
                    object.endsAt = typeof message.endsAt === "number" ? $BigInt(message.endsAt) : $util.Long.fromBits(message.endsAt.low >>> 0, message.endsAt.high >>> 0, false).toBigInt();
                else if (typeof message.endsAt === "number")
                    object.endsAt = options.longs === $String ? $String(message.endsAt) : message.endsAt;
                else
                    object.endsAt = options.longs === $String ? $util.Long.prototype.toString.call(message.endsAt) : options.longs === $Number ? new $util.LongBits(message.endsAt.low >>> 0, message.endsAt.high >>> 0).toNumber() : message.endsAt;
            return object;
        };

        /**
         * Converts this PollMsg to JSON.
         * @function toJSON
         * @memberof canari.PollMsg
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        PollMsg.prototype.toJSON = function() {
            return PollMsg.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for PollMsg
         * @function getTypeUrl
         * @memberof canari.PollMsg
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        PollMsg.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/canari.PollMsg";
        };

        var C = PollMsg;

        return PollMsg;
    })();

    /**
     * MediaKind enum.
     * @name canari.MediaKind
     * @enum {number}
     * @property {number} MEDIA_FILE=0 MEDIA_FILE value
     * @property {number} MEDIA_IMAGE=1 MEDIA_IMAGE value
     * @property {number} MEDIA_VIDEO=2 MEDIA_VIDEO value
     * @property {number} MEDIA_AUDIO=3 MEDIA_AUDIO value
     */
    canari.MediaKind = (function() {
        const valuesById = {}, values = $Object.create(valuesById);
        values[valuesById[0] = "MEDIA_FILE"] = 0;
        values[valuesById[1] = "MEDIA_IMAGE"] = 1;
        values[valuesById[2] = "MEDIA_VIDEO"] = 2;
        values[valuesById[3] = "MEDIA_AUDIO"] = 3;
        return values;
    })();

    canari.MediaMsg = (function() {

        /**
         * Properties of a MediaMsg.
         * @typedef {Object} canari.MediaMsg.$Properties
         * @property {canari.MediaKind|null} [kind] MediaMsg kind
         * @property {string|null} [mediaId] MediaMsg mediaId
         * @property {Uint8Array|null} [key] MediaMsg key
         * @property {Uint8Array|null} [iv] MediaMsg iv
         * @property {string|null} [mimeType] MediaMsg mimeType
         * @property {number|null} [size] MediaMsg size
         * @property {string|null} [fileName] MediaMsg fileName
         * @property {string|null} [caption] MediaMsg caption
         * @property {number|null} [width] MediaMsg width
         * @property {number|null} [height] MediaMsg height
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of a MediaMsg.
         * @memberof canari
         * @interface IMediaMsg
         * @augments canari.MediaMsg.$Properties
         * @deprecated Use canari.MediaMsg.$Properties instead.
         */

        /**
         * Shape of a MediaMsg.
         * @typedef {canari.MediaMsg.$Properties} canari.MediaMsg.$Shape
         */

        /**
         * Constructs a new MediaMsg.
         * @memberof canari
         * @classdesc Represents a MediaMsg.
         * @constructor
         * @param {canari.MediaMsg.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        const MediaMsg = function (properties) {
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        /**
         * MediaMsg kind.
         * @member {canari.MediaKind} kind
         * @memberof canari.MediaMsg
         * @instance
         */
        MediaMsg.prototype.kind = 0;

        /**
         * MediaMsg mediaId.
         * @member {string} mediaId
         * @memberof canari.MediaMsg
         * @instance
         */
        MediaMsg.prototype.mediaId = "";

        /**
         * MediaMsg key.
         * @member {Uint8Array} key
         * @memberof canari.MediaMsg
         * @instance
         */
        MediaMsg.prototype.key = $util.newBuffer([]);

        /**
         * MediaMsg iv.
         * @member {Uint8Array} iv
         * @memberof canari.MediaMsg
         * @instance
         */
        MediaMsg.prototype.iv = $util.newBuffer([]);

        /**
         * MediaMsg mimeType.
         * @member {string} mimeType
         * @memberof canari.MediaMsg
         * @instance
         */
        MediaMsg.prototype.mimeType = "";

        /**
         * MediaMsg size.
         * @member {number} size
         * @memberof canari.MediaMsg
         * @instance
         */
        MediaMsg.prototype.size = 0;

        /**
         * MediaMsg fileName.
         * @member {string} fileName
         * @memberof canari.MediaMsg
         * @instance
         */
        MediaMsg.prototype.fileName = "";

        /**
         * MediaMsg caption.
         * @member {string} caption
         * @memberof canari.MediaMsg
         * @instance
         */
        MediaMsg.prototype.caption = "";

        /**
         * MediaMsg width.
         * @member {number} width
         * @memberof canari.MediaMsg
         * @instance
         */
        MediaMsg.prototype.width = 0;

        /**
         * MediaMsg height.
         * @member {number} height
         * @memberof canari.MediaMsg
         * @instance
         */
        MediaMsg.prototype.height = 0;

        /**
         * Creates a new MediaMsg instance using the specified properties.
         * @function create
         * @memberof canari.MediaMsg
         * @static
         * @param {canari.MediaMsg.$Properties=} [properties] Properties to set
         * @returns {canari.MediaMsg} MediaMsg instance
         * @type {{
         *   (properties: canari.MediaMsg.$Shape): canari.MediaMsg & canari.MediaMsg.$Shape;
         *   (properties?: canari.MediaMsg.$Properties): canari.MediaMsg;
         * }}
         */
        MediaMsg.create = function(properties) {
            return new MediaMsg(properties);
        };

        /**
         * Encodes the specified MediaMsg message. Does not implicitly {@link canari.MediaMsg.verify|verify} messages.
         * @function encode
         * @memberof canari.MediaMsg
         * @static
         * @param {canari.MediaMsg.$Properties} message MediaMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        MediaMsg.encode = function (message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            if (message.kind != null && $Object.hasOwnProperty.call(message, "kind"))
                writer.uint32(/* id 1, wireType 0 =*/8).int32(message.kind);
            if (message.mediaId != null && $Object.hasOwnProperty.call(message, "mediaId"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.mediaId);
            if (message.key != null && $Object.hasOwnProperty.call(message, "key"))
                writer.uint32(/* id 3, wireType 2 =*/26).bytes(message.key);
            if (message.iv != null && $Object.hasOwnProperty.call(message, "iv"))
                writer.uint32(/* id 4, wireType 2 =*/34).bytes(message.iv);
            if (message.mimeType != null && $Object.hasOwnProperty.call(message, "mimeType"))
                writer.uint32(/* id 5, wireType 2 =*/42).string(message.mimeType);
            if (message.size != null && $Object.hasOwnProperty.call(message, "size"))
                writer.uint32(/* id 6, wireType 0 =*/48).uint32(message.size);
            if (message.fileName != null && $Object.hasOwnProperty.call(message, "fileName"))
                writer.uint32(/* id 7, wireType 2 =*/58).string(message.fileName);
            if (message.caption != null && $Object.hasOwnProperty.call(message, "caption"))
                writer.uint32(/* id 8, wireType 2 =*/66).string(message.caption);
            if (message.width != null && $Object.hasOwnProperty.call(message, "width"))
                writer.uint32(/* id 9, wireType 0 =*/72).uint32(message.width);
            if (message.height != null && $Object.hasOwnProperty.call(message, "height"))
                writer.uint32(/* id 10, wireType 0 =*/80).uint32(message.height);
            if (message.$unknowns != null && $Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified MediaMsg message, length delimited. Does not implicitly {@link canari.MediaMsg.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.MediaMsg
         * @static
         * @param {canari.MediaMsg.$Properties} message MediaMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        MediaMsg.encodeDelimited = function(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes a MediaMsg message from the specified reader or buffer.
         * @function decode
         * @memberof canari.MediaMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.MediaMsg & canari.MediaMsg.$Shape} MediaMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        MediaMsg.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end = length === $undefined ? reader.len : reader.pos + length, message = _target || new $root.canari.MediaMsg(), value;
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 0)
                            break;
                        if (value = reader.int32())
                            message.kind = value;
                        else
                            delete message.kind;
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.mediaId = value;
                        else
                            delete message.mediaId;
                        continue;
                    }
                case 3: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.bytes()).length)
                            message.key = value;
                        else
                            delete message.key;
                        continue;
                    }
                case 4: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.bytes()).length)
                            message.iv = value;
                        else
                            delete message.iv;
                        continue;
                    }
                case 5: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.mimeType = value;
                        else
                            delete message.mimeType;
                        continue;
                    }
                case 6: {
                        if (wireType !== 0)
                            break;
                        if (value = reader.uint32())
                            message.size = value;
                        else
                            delete message.size;
                        continue;
                    }
                case 7: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.fileName = value;
                        else
                            delete message.fileName;
                        continue;
                    }
                case 8: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.caption = value;
                        else
                            delete message.caption;
                        continue;
                    }
                case 9: {
                        if (wireType !== 0)
                            break;
                        if (value = reader.uint32())
                            message.width = value;
                        else
                            delete message.width;
                        continue;
                    }
                case 10: {
                        if (wireType !== 0)
                            break;
                        if (value = reader.uint32())
                            message.height = value;
                        else
                            delete message.height;
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            return message;
        };

        /**
         * Decodes a MediaMsg message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.MediaMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.MediaMsg & canari.MediaMsg.$Shape} MediaMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        MediaMsg.decodeDelimited = function(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a MediaMsg message.
         * @function verify
         * @memberof canari.MediaMsg
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        MediaMsg.verify = function (message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.kind != null && $Object.hasOwnProperty.call(message, "kind"))
                switch (message.kind) {
                default:
                    return "kind: enum value expected";
                case 0:
                case 1:
                case 2:
                case 3:
                    break;
                }
            if (message.mediaId != null && $Object.hasOwnProperty.call(message, "mediaId"))
                if (!$util.isString(message.mediaId))
                    return "mediaId: string expected";
            if (message.key != null && $Object.hasOwnProperty.call(message, "key"))
                if (!(message.key && typeof message.key.length === "number" || $util.isString(message.key)))
                    return "key: buffer expected";
            if (message.iv != null && $Object.hasOwnProperty.call(message, "iv"))
                if (!(message.iv && typeof message.iv.length === "number" || $util.isString(message.iv)))
                    return "iv: buffer expected";
            if (message.mimeType != null && $Object.hasOwnProperty.call(message, "mimeType"))
                if (!$util.isString(message.mimeType))
                    return "mimeType: string expected";
            if (message.size != null && $Object.hasOwnProperty.call(message, "size"))
                if (!$util.isInteger(message.size))
                    return "size: integer expected";
            if (message.fileName != null && $Object.hasOwnProperty.call(message, "fileName"))
                if (!$util.isString(message.fileName))
                    return "fileName: string expected";
            if (message.caption != null && $Object.hasOwnProperty.call(message, "caption"))
                if (!$util.isString(message.caption))
                    return "caption: string expected";
            if (message.width != null && $Object.hasOwnProperty.call(message, "width"))
                if (!$util.isInteger(message.width))
                    return "width: integer expected";
            if (message.height != null && $Object.hasOwnProperty.call(message, "height"))
                if (!$util.isInteger(message.height))
                    return "height: integer expected";
            return null;
        };

        /**
         * Creates a MediaMsg message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof canari.MediaMsg
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {canari.MediaMsg} MediaMsg
         */
        MediaMsg.fromObject = function (object, _depth) {
            if (object instanceof $root.canari.MediaMsg)
                return object;
            if (!$util.isObject(object))
                throw $TypeError(".canari.MediaMsg: object expected");
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let message = new $root.canari.MediaMsg();
            if (object.kind !== 0 && (typeof object.kind !== "string" || $root.canari.MediaKind[object.kind] !== 0))
                switch (object.kind) {
                default:
                    if (typeof object.kind === "number") {
                        message.kind = object.kind;
                        break;
                    }
                    break;
                case "MEDIA_FILE":
                case 0:
                    message.kind = 0;
                    break;
                case "MEDIA_IMAGE":
                case 1:
                    message.kind = 1;
                    break;
                case "MEDIA_VIDEO":
                case 2:
                    message.kind = 2;
                    break;
                case "MEDIA_AUDIO":
                case 3:
                    message.kind = 3;
                    break;
                }
            if (object.mediaId != null)
                if (typeof object.mediaId !== "string" || object.mediaId.length)
                    message.mediaId = $String(object.mediaId);
            if (object.key != null)
                if (object.key.length)
                    if (typeof object.key === "string")
                        $util.base64.decode(object.key, message.key = $util.newBuffer($util.base64.length(object.key)), 0);
                    else if (object.key.length >= 0)
                        message.key = object.key;
            if (object.iv != null)
                if (object.iv.length)
                    if (typeof object.iv === "string")
                        $util.base64.decode(object.iv, message.iv = $util.newBuffer($util.base64.length(object.iv)), 0);
                    else if (object.iv.length >= 0)
                        message.iv = object.iv;
            if (object.mimeType != null)
                if (typeof object.mimeType !== "string" || object.mimeType.length)
                    message.mimeType = $String(object.mimeType);
            if (object.size != null)
                if ($Number(object.size) !== 0)
                    message.size = object.size >>> 0;
            if (object.fileName != null)
                if (typeof object.fileName !== "string" || object.fileName.length)
                    message.fileName = $String(object.fileName);
            if (object.caption != null)
                if (typeof object.caption !== "string" || object.caption.length)
                    message.caption = $String(object.caption);
            if (object.width != null)
                if ($Number(object.width) !== 0)
                    message.width = object.width >>> 0;
            if (object.height != null)
                if ($Number(object.height) !== 0)
                    message.height = object.height >>> 0;
            return message;
        };

        /**
         * Creates a plain object from a MediaMsg message. Also converts values to other types if specified.
         * @function toObject
         * @memberof canari.MediaMsg
         * @static
         * @param {canari.MediaMsg} message MediaMsg
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        MediaMsg.toObject = function (message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let object = {};
            if (options.defaults) {
                object.kind = options.enums === $String ? "MEDIA_FILE" : 0;
                object.mediaId = "";
                if (options.bytes === $String)
                    object.key = "";
                else {
                    object.key = [];
                    if (options.bytes !== $Array)
                        object.key = $util.newBuffer(object.key);
                }
                if (options.bytes === $String)
                    object.iv = "";
                else {
                    object.iv = [];
                    if (options.bytes !== $Array)
                        object.iv = $util.newBuffer(object.iv);
                }
                object.mimeType = "";
                object.size = 0;
                object.fileName = "";
                object.caption = "";
                object.width = 0;
                object.height = 0;
            }
            if (message.kind != null && $Object.hasOwnProperty.call(message, "kind"))
                object.kind = options.enums === $String ? $root.canari.MediaKind[message.kind] === $undefined ? message.kind : $root.canari.MediaKind[message.kind] : message.kind;
            if (message.mediaId != null && $Object.hasOwnProperty.call(message, "mediaId"))
                object.mediaId = message.mediaId;
            if (message.key != null && $Object.hasOwnProperty.call(message, "key"))
                object.key = options.bytes === $String ? $util.base64.encode(message.key, 0, message.key.length) : options.bytes === $Array ? $Array.prototype.slice.call(message.key) : message.key;
            if (message.iv != null && $Object.hasOwnProperty.call(message, "iv"))
                object.iv = options.bytes === $String ? $util.base64.encode(message.iv, 0, message.iv.length) : options.bytes === $Array ? $Array.prototype.slice.call(message.iv) : message.iv;
            if (message.mimeType != null && $Object.hasOwnProperty.call(message, "mimeType"))
                object.mimeType = message.mimeType;
            if (message.size != null && $Object.hasOwnProperty.call(message, "size"))
                object.size = message.size;
            if (message.fileName != null && $Object.hasOwnProperty.call(message, "fileName"))
                object.fileName = message.fileName;
            if (message.caption != null && $Object.hasOwnProperty.call(message, "caption"))
                object.caption = message.caption;
            if (message.width != null && $Object.hasOwnProperty.call(message, "width"))
                object.width = message.width;
            if (message.height != null && $Object.hasOwnProperty.call(message, "height"))
                object.height = message.height;
            return object;
        };

        /**
         * Converts this MediaMsg to JSON.
         * @function toJSON
         * @memberof canari.MediaMsg
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        MediaMsg.prototype.toJSON = function() {
            return MediaMsg.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for MediaMsg
         * @function getTypeUrl
         * @memberof canari.MediaMsg
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        MediaMsg.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/canari.MediaMsg";
        };

        var C = MediaMsg;

        return MediaMsg;
    })();

    canari.SystemMsg = (function() {

        /**
         * Properties of a SystemMsg.
         * @typedef {Object} canari.SystemMsg.$Properties
         * @property {string|null} [event] SystemMsg event
         * @property {string|null} [data] SystemMsg data
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of a SystemMsg.
         * @memberof canari
         * @interface ISystemMsg
         * @augments canari.SystemMsg.$Properties
         * @deprecated Use canari.SystemMsg.$Properties instead.
         */

        /**
         * Shape of a SystemMsg.
         * @typedef {canari.SystemMsg.$Properties} canari.SystemMsg.$Shape
         */

        /**
         * Constructs a new SystemMsg.
         * @memberof canari
         * @classdesc Represents a SystemMsg.
         * @constructor
         * @param {canari.SystemMsg.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        const SystemMsg = function (properties) {
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        /**
         * SystemMsg event.
         * @member {string} event
         * @memberof canari.SystemMsg
         * @instance
         */
        SystemMsg.prototype.event = "";

        /**
         * SystemMsg data.
         * @member {string} data
         * @memberof canari.SystemMsg
         * @instance
         */
        SystemMsg.prototype.data = "";

        /**
         * Creates a new SystemMsg instance using the specified properties.
         * @function create
         * @memberof canari.SystemMsg
         * @static
         * @param {canari.SystemMsg.$Properties=} [properties] Properties to set
         * @returns {canari.SystemMsg} SystemMsg instance
         * @type {{
         *   (properties: canari.SystemMsg.$Shape): canari.SystemMsg & canari.SystemMsg.$Shape;
         *   (properties?: canari.SystemMsg.$Properties): canari.SystemMsg;
         * }}
         */
        SystemMsg.create = function(properties) {
            return new SystemMsg(properties);
        };

        /**
         * Encodes the specified SystemMsg message. Does not implicitly {@link canari.SystemMsg.verify|verify} messages.
         * @function encode
         * @memberof canari.SystemMsg
         * @static
         * @param {canari.SystemMsg.$Properties} message SystemMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        SystemMsg.encode = function (message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            if (message.event != null && $Object.hasOwnProperty.call(message, "event"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.event);
            if (message.data != null && $Object.hasOwnProperty.call(message, "data"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.data);
            if (message.$unknowns != null && $Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified SystemMsg message, length delimited. Does not implicitly {@link canari.SystemMsg.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.SystemMsg
         * @static
         * @param {canari.SystemMsg.$Properties} message SystemMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        SystemMsg.encodeDelimited = function(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes a SystemMsg message from the specified reader or buffer.
         * @function decode
         * @memberof canari.SystemMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.SystemMsg & canari.SystemMsg.$Shape} SystemMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        SystemMsg.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end = length === $undefined ? reader.len : reader.pos + length, message = _target || new $root.canari.SystemMsg(), value;
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.event = value;
                        else
                            delete message.event;
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.data = value;
                        else
                            delete message.data;
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            return message;
        };

        /**
         * Decodes a SystemMsg message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.SystemMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.SystemMsg & canari.SystemMsg.$Shape} SystemMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        SystemMsg.decodeDelimited = function(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a SystemMsg message.
         * @function verify
         * @memberof canari.SystemMsg
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        SystemMsg.verify = function (message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.event != null && $Object.hasOwnProperty.call(message, "event"))
                if (!$util.isString(message.event))
                    return "event: string expected";
            if (message.data != null && $Object.hasOwnProperty.call(message, "data"))
                if (!$util.isString(message.data))
                    return "data: string expected";
            return null;
        };

        /**
         * Creates a SystemMsg message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof canari.SystemMsg
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {canari.SystemMsg} SystemMsg
         */
        SystemMsg.fromObject = function (object, _depth) {
            if (object instanceof $root.canari.SystemMsg)
                return object;
            if (!$util.isObject(object))
                throw $TypeError(".canari.SystemMsg: object expected");
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let message = new $root.canari.SystemMsg();
            if (object.event != null)
                if (typeof object.event !== "string" || object.event.length)
                    message.event = $String(object.event);
            if (object.data != null)
                if (typeof object.data !== "string" || object.data.length)
                    message.data = $String(object.data);
            return message;
        };

        /**
         * Creates a plain object from a SystemMsg message. Also converts values to other types if specified.
         * @function toObject
         * @memberof canari.SystemMsg
         * @static
         * @param {canari.SystemMsg} message SystemMsg
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        SystemMsg.toObject = function (message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let object = {};
            if (options.defaults) {
                object.event = "";
                object.data = "";
            }
            if (message.event != null && $Object.hasOwnProperty.call(message, "event"))
                object.event = message.event;
            if (message.data != null && $Object.hasOwnProperty.call(message, "data"))
                object.data = message.data;
            return object;
        };

        /**
         * Converts this SystemMsg to JSON.
         * @function toJSON
         * @memberof canari.SystemMsg
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        SystemMsg.prototype.toJSON = function() {
            return SystemMsg.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for SystemMsg
         * @function getTypeUrl
         * @memberof canari.SystemMsg
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        SystemMsg.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/canari.SystemMsg";
        };

        var C = SystemMsg;

        return SystemMsg;
    })();

    return canari;
})();

export {
  $root as default
};
