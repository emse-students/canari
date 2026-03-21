/*eslint-disable block-scoped-var, id-length, no-control-regex, no-magic-numbers, no-prototype-builtins, no-redeclare, no-shadow, no-var, sort-vars*/
import * as $protobuf from "protobufjs/minimal";

// Common aliases
const $Reader = $protobuf.Reader, $Writer = $protobuf.Writer, $util = $protobuf.util;

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
         * @memberof canari
         * @interface IWsEnvelope
         * @property {canari.IMlsFrame|null} [mls] WsEnvelope mls
         * @property {canari.IWelcomeFrame|null} [welcome] WsEnvelope welcome
         * @property {canari.IReadAck|null} [read] WsEnvelope read
         */

        /**
         * Constructs a new WsEnvelope.
         * @memberof canari
         * @classdesc Represents a WsEnvelope.
         * @implements IWsEnvelope
         * @constructor
         * @param {canari.IWsEnvelope=} [properties] Properties to set
         */
        function WsEnvelope(properties) {
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * WsEnvelope mls.
         * @member {canari.IMlsFrame|null|undefined} mls
         * @memberof canari.WsEnvelope
         * @instance
         */
        WsEnvelope.prototype.mls = null;

        /**
         * WsEnvelope welcome.
         * @member {canari.IWelcomeFrame|null|undefined} welcome
         * @memberof canari.WsEnvelope
         * @instance
         */
        WsEnvelope.prototype.welcome = null;

        /**
         * WsEnvelope read.
         * @member {canari.IReadAck|null|undefined} read
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
        Object.defineProperty(WsEnvelope.prototype, "body", {
            get: $util.oneOfGetter($oneOfFields = ["mls", "welcome", "read"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        /**
         * Creates a new WsEnvelope instance using the specified properties.
         * @function create
         * @memberof canari.WsEnvelope
         * @static
         * @param {canari.IWsEnvelope=} [properties] Properties to set
         * @returns {canari.WsEnvelope} WsEnvelope instance
         */
        WsEnvelope.create = function create(properties) {
            return new WsEnvelope(properties);
        };

        /**
         * Encodes the specified WsEnvelope message. Does not implicitly {@link canari.WsEnvelope.verify|verify} messages.
         * @function encode
         * @memberof canari.WsEnvelope
         * @static
         * @param {canari.IWsEnvelope} message WsEnvelope message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        WsEnvelope.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.mls != null && Object.hasOwnProperty.call(message, "mls"))
                $root.canari.MlsFrame.encode(message.mls, writer.uint32(/* id 1, wireType 2 =*/10).fork()).ldelim();
            if (message.welcome != null && Object.hasOwnProperty.call(message, "welcome"))
                $root.canari.WelcomeFrame.encode(message.welcome, writer.uint32(/* id 2, wireType 2 =*/18).fork()).ldelim();
            if (message.read != null && Object.hasOwnProperty.call(message, "read"))
                $root.canari.ReadAck.encode(message.read, writer.uint32(/* id 3, wireType 2 =*/26).fork()).ldelim();
            return writer;
        };

        /**
         * Encodes the specified WsEnvelope message, length delimited. Does not implicitly {@link canari.WsEnvelope.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.WsEnvelope
         * @static
         * @param {canari.IWsEnvelope} message WsEnvelope message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        WsEnvelope.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a WsEnvelope message from the specified reader or buffer.
         * @function decode
         * @memberof canari.WsEnvelope
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.WsEnvelope} WsEnvelope
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        WsEnvelope.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.canari.WsEnvelope();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.mls = $root.canari.MlsFrame.decode(reader, reader.uint32());
                        break;
                    }
                case 2: {
                        message.welcome = $root.canari.WelcomeFrame.decode(reader, reader.uint32());
                        break;
                    }
                case 3: {
                        message.read = $root.canari.ReadAck.decode(reader, reader.uint32());
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a WsEnvelope message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.WsEnvelope
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.WsEnvelope} WsEnvelope
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        WsEnvelope.decodeDelimited = function decodeDelimited(reader) {
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
        WsEnvelope.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            let properties = {};
            if (message.mls != null && message.hasOwnProperty("mls")) {
                properties.body = 1;
                {
                    let error = $root.canari.MlsFrame.verify(message.mls);
                    if (error)
                        return "mls." + error;
                }
            }
            if (message.welcome != null && message.hasOwnProperty("welcome")) {
                if (properties.body === 1)
                    return "body: multiple values";
                properties.body = 1;
                {
                    let error = $root.canari.WelcomeFrame.verify(message.welcome);
                    if (error)
                        return "welcome." + error;
                }
            }
            if (message.read != null && message.hasOwnProperty("read")) {
                if (properties.body === 1)
                    return "body: multiple values";
                properties.body = 1;
                {
                    let error = $root.canari.ReadAck.verify(message.read);
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
        WsEnvelope.fromObject = function fromObject(object) {
            if (object instanceof $root.canari.WsEnvelope)
                return object;
            let message = new $root.canari.WsEnvelope();
            if (object.mls != null) {
                if (typeof object.mls !== "object")
                    throw TypeError(".canari.WsEnvelope.mls: object expected");
                message.mls = $root.canari.MlsFrame.fromObject(object.mls);
            }
            if (object.welcome != null) {
                if (typeof object.welcome !== "object")
                    throw TypeError(".canari.WsEnvelope.welcome: object expected");
                message.welcome = $root.canari.WelcomeFrame.fromObject(object.welcome);
            }
            if (object.read != null) {
                if (typeof object.read !== "object")
                    throw TypeError(".canari.WsEnvelope.read: object expected");
                message.read = $root.canari.ReadAck.fromObject(object.read);
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
        WsEnvelope.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (message.mls != null && message.hasOwnProperty("mls")) {
                object.mls = $root.canari.MlsFrame.toObject(message.mls, options);
                if (options.oneofs)
                    object.body = "mls";
            }
            if (message.welcome != null && message.hasOwnProperty("welcome")) {
                object.welcome = $root.canari.WelcomeFrame.toObject(message.welcome, options);
                if (options.oneofs)
                    object.body = "welcome";
            }
            if (message.read != null && message.hasOwnProperty("read")) {
                object.read = $root.canari.ReadAck.toObject(message.read, options);
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
        WsEnvelope.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for WsEnvelope
         * @function getTypeUrl
         * @memberof canari.WsEnvelope
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        WsEnvelope.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/canari.WsEnvelope";
        };

        return WsEnvelope;
    })();

    canari.Recipient = (function() {

        /**
         * Properties of a Recipient.
         * @memberof canari
         * @interface IRecipient
         * @property {string|null} [userId] Recipient userId
         * @property {string|null} [deviceId] Recipient deviceId
         */

        /**
         * Constructs a new Recipient.
         * @memberof canari
         * @classdesc Represents a Recipient.
         * @implements IRecipient
         * @constructor
         * @param {canari.IRecipient=} [properties] Properties to set
         */
        function Recipient(properties) {
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

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
         * @param {canari.IRecipient=} [properties] Properties to set
         * @returns {canari.Recipient} Recipient instance
         */
        Recipient.create = function create(properties) {
            return new Recipient(properties);
        };

        /**
         * Encodes the specified Recipient message. Does not implicitly {@link canari.Recipient.verify|verify} messages.
         * @function encode
         * @memberof canari.Recipient
         * @static
         * @param {canari.IRecipient} message Recipient message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Recipient.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.userId != null && Object.hasOwnProperty.call(message, "userId"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.userId);
            if (message.deviceId != null && Object.hasOwnProperty.call(message, "deviceId"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.deviceId);
            return writer;
        };

        /**
         * Encodes the specified Recipient message, length delimited. Does not implicitly {@link canari.Recipient.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.Recipient
         * @static
         * @param {canari.IRecipient} message Recipient message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Recipient.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a Recipient message from the specified reader or buffer.
         * @function decode
         * @memberof canari.Recipient
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.Recipient} Recipient
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Recipient.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.canari.Recipient();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.userId = reader.string();
                        break;
                    }
                case 2: {
                        message.deviceId = reader.string();
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a Recipient message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.Recipient
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.Recipient} Recipient
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Recipient.decodeDelimited = function decodeDelimited(reader) {
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
        Recipient.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.userId != null && message.hasOwnProperty("userId"))
                if (!$util.isString(message.userId))
                    return "userId: string expected";
            if (message.deviceId != null && message.hasOwnProperty("deviceId"))
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
        Recipient.fromObject = function fromObject(object) {
            if (object instanceof $root.canari.Recipient)
                return object;
            let message = new $root.canari.Recipient();
            if (object.userId != null)
                message.userId = String(object.userId);
            if (object.deviceId != null)
                message.deviceId = String(object.deviceId);
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
        Recipient.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.defaults) {
                object.userId = "";
                object.deviceId = "";
            }
            if (message.userId != null && message.hasOwnProperty("userId"))
                object.userId = message.userId;
            if (message.deviceId != null && message.hasOwnProperty("deviceId"))
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
        Recipient.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for Recipient
         * @function getTypeUrl
         * @memberof canari.Recipient
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        Recipient.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/canari.Recipient";
        };

        return Recipient;
    })();

    canari.MlsFrame = (function() {

        /**
         * Properties of a MlsFrame.
         * @memberof canari
         * @interface IMlsFrame
         * @property {Uint8Array|null} [ciphertext] MlsFrame ciphertext
         * @property {string|null} [groupId] MlsFrame groupId
         * @property {Array.<canari.IRecipient>|null} [recipients] MlsFrame recipients
         */

        /**
         * Constructs a new MlsFrame.
         * @memberof canari
         * @classdesc Represents a MlsFrame.
         * @implements IMlsFrame
         * @constructor
         * @param {canari.IMlsFrame=} [properties] Properties to set
         */
        function MlsFrame(properties) {
            this.recipients = [];
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

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
         * @member {Array.<canari.IRecipient>} recipients
         * @memberof canari.MlsFrame
         * @instance
         */
        MlsFrame.prototype.recipients = $util.emptyArray;

        /**
         * Creates a new MlsFrame instance using the specified properties.
         * @function create
         * @memberof canari.MlsFrame
         * @static
         * @param {canari.IMlsFrame=} [properties] Properties to set
         * @returns {canari.MlsFrame} MlsFrame instance
         */
        MlsFrame.create = function create(properties) {
            return new MlsFrame(properties);
        };

        /**
         * Encodes the specified MlsFrame message. Does not implicitly {@link canari.MlsFrame.verify|verify} messages.
         * @function encode
         * @memberof canari.MlsFrame
         * @static
         * @param {canari.IMlsFrame} message MlsFrame message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        MlsFrame.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.ciphertext != null && Object.hasOwnProperty.call(message, "ciphertext"))
                writer.uint32(/* id 1, wireType 2 =*/10).bytes(message.ciphertext);
            if (message.groupId != null && Object.hasOwnProperty.call(message, "groupId"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.groupId);
            if (message.recipients != null && message.recipients.length)
                for (let i = 0; i < message.recipients.length; ++i)
                    $root.canari.Recipient.encode(message.recipients[i], writer.uint32(/* id 3, wireType 2 =*/26).fork()).ldelim();
            return writer;
        };

        /**
         * Encodes the specified MlsFrame message, length delimited. Does not implicitly {@link canari.MlsFrame.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.MlsFrame
         * @static
         * @param {canari.IMlsFrame} message MlsFrame message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        MlsFrame.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a MlsFrame message from the specified reader or buffer.
         * @function decode
         * @memberof canari.MlsFrame
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.MlsFrame} MlsFrame
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        MlsFrame.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.canari.MlsFrame();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.ciphertext = reader.bytes();
                        break;
                    }
                case 2: {
                        message.groupId = reader.string();
                        break;
                    }
                case 3: {
                        if (!(message.recipients && message.recipients.length))
                            message.recipients = [];
                        message.recipients.push($root.canari.Recipient.decode(reader, reader.uint32()));
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a MlsFrame message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.MlsFrame
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.MlsFrame} MlsFrame
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        MlsFrame.decodeDelimited = function decodeDelimited(reader) {
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
        MlsFrame.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.ciphertext != null && message.hasOwnProperty("ciphertext"))
                if (!(message.ciphertext && typeof message.ciphertext.length === "number" || $util.isString(message.ciphertext)))
                    return "ciphertext: buffer expected";
            if (message.groupId != null && message.hasOwnProperty("groupId"))
                if (!$util.isString(message.groupId))
                    return "groupId: string expected";
            if (message.recipients != null && message.hasOwnProperty("recipients")) {
                if (!Array.isArray(message.recipients))
                    return "recipients: array expected";
                for (let i = 0; i < message.recipients.length; ++i) {
                    let error = $root.canari.Recipient.verify(message.recipients[i]);
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
        MlsFrame.fromObject = function fromObject(object) {
            if (object instanceof $root.canari.MlsFrame)
                return object;
            let message = new $root.canari.MlsFrame();
            if (object.ciphertext != null)
                if (typeof object.ciphertext === "string")
                    $util.base64.decode(object.ciphertext, message.ciphertext = $util.newBuffer($util.base64.length(object.ciphertext)), 0);
                else if (object.ciphertext.length >= 0)
                    message.ciphertext = object.ciphertext;
            if (object.groupId != null)
                message.groupId = String(object.groupId);
            if (object.recipients) {
                if (!Array.isArray(object.recipients))
                    throw TypeError(".canari.MlsFrame.recipients: array expected");
                message.recipients = [];
                for (let i = 0; i < object.recipients.length; ++i) {
                    if (typeof object.recipients[i] !== "object")
                        throw TypeError(".canari.MlsFrame.recipients: object expected");
                    message.recipients[i] = $root.canari.Recipient.fromObject(object.recipients[i]);
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
        MlsFrame.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.arrays || options.defaults)
                object.recipients = [];
            if (options.defaults) {
                if (options.bytes === String)
                    object.ciphertext = "";
                else {
                    object.ciphertext = [];
                    if (options.bytes !== Array)
                        object.ciphertext = $util.newBuffer(object.ciphertext);
                }
                object.groupId = "";
            }
            if (message.ciphertext != null && message.hasOwnProperty("ciphertext"))
                object.ciphertext = options.bytes === String ? $util.base64.encode(message.ciphertext, 0, message.ciphertext.length) : options.bytes === Array ? Array.prototype.slice.call(message.ciphertext) : message.ciphertext;
            if (message.groupId != null && message.hasOwnProperty("groupId"))
                object.groupId = message.groupId;
            if (message.recipients && message.recipients.length) {
                object.recipients = [];
                for (let j = 0; j < message.recipients.length; ++j)
                    object.recipients[j] = $root.canari.Recipient.toObject(message.recipients[j], options);
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
        MlsFrame.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for MlsFrame
         * @function getTypeUrl
         * @memberof canari.MlsFrame
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        MlsFrame.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/canari.MlsFrame";
        };

        return MlsFrame;
    })();

    canari.WelcomeFrame = (function() {

        /**
         * Properties of a WelcomeFrame.
         * @memberof canari
         * @interface IWelcomeFrame
         * @property {Uint8Array|null} [ciphertext] WelcomeFrame ciphertext
         * @property {string|null} [groupId] WelcomeFrame groupId
         * @property {Array.<canari.IRecipient>|null} [recipients] WelcomeFrame recipients
         */

        /**
         * Constructs a new WelcomeFrame.
         * @memberof canari
         * @classdesc Represents a WelcomeFrame.
         * @implements IWelcomeFrame
         * @constructor
         * @param {canari.IWelcomeFrame=} [properties] Properties to set
         */
        function WelcomeFrame(properties) {
            this.recipients = [];
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

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
         * @member {Array.<canari.IRecipient>} recipients
         * @memberof canari.WelcomeFrame
         * @instance
         */
        WelcomeFrame.prototype.recipients = $util.emptyArray;

        /**
         * Creates a new WelcomeFrame instance using the specified properties.
         * @function create
         * @memberof canari.WelcomeFrame
         * @static
         * @param {canari.IWelcomeFrame=} [properties] Properties to set
         * @returns {canari.WelcomeFrame} WelcomeFrame instance
         */
        WelcomeFrame.create = function create(properties) {
            return new WelcomeFrame(properties);
        };

        /**
         * Encodes the specified WelcomeFrame message. Does not implicitly {@link canari.WelcomeFrame.verify|verify} messages.
         * @function encode
         * @memberof canari.WelcomeFrame
         * @static
         * @param {canari.IWelcomeFrame} message WelcomeFrame message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        WelcomeFrame.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.ciphertext != null && Object.hasOwnProperty.call(message, "ciphertext"))
                writer.uint32(/* id 1, wireType 2 =*/10).bytes(message.ciphertext);
            if (message.groupId != null && Object.hasOwnProperty.call(message, "groupId"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.groupId);
            if (message.recipients != null && message.recipients.length)
                for (let i = 0; i < message.recipients.length; ++i)
                    $root.canari.Recipient.encode(message.recipients[i], writer.uint32(/* id 3, wireType 2 =*/26).fork()).ldelim();
            return writer;
        };

        /**
         * Encodes the specified WelcomeFrame message, length delimited. Does not implicitly {@link canari.WelcomeFrame.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.WelcomeFrame
         * @static
         * @param {canari.IWelcomeFrame} message WelcomeFrame message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        WelcomeFrame.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a WelcomeFrame message from the specified reader or buffer.
         * @function decode
         * @memberof canari.WelcomeFrame
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.WelcomeFrame} WelcomeFrame
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        WelcomeFrame.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.canari.WelcomeFrame();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.ciphertext = reader.bytes();
                        break;
                    }
                case 2: {
                        message.groupId = reader.string();
                        break;
                    }
                case 3: {
                        if (!(message.recipients && message.recipients.length))
                            message.recipients = [];
                        message.recipients.push($root.canari.Recipient.decode(reader, reader.uint32()));
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a WelcomeFrame message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.WelcomeFrame
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.WelcomeFrame} WelcomeFrame
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        WelcomeFrame.decodeDelimited = function decodeDelimited(reader) {
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
        WelcomeFrame.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.ciphertext != null && message.hasOwnProperty("ciphertext"))
                if (!(message.ciphertext && typeof message.ciphertext.length === "number" || $util.isString(message.ciphertext)))
                    return "ciphertext: buffer expected";
            if (message.groupId != null && message.hasOwnProperty("groupId"))
                if (!$util.isString(message.groupId))
                    return "groupId: string expected";
            if (message.recipients != null && message.hasOwnProperty("recipients")) {
                if (!Array.isArray(message.recipients))
                    return "recipients: array expected";
                for (let i = 0; i < message.recipients.length; ++i) {
                    let error = $root.canari.Recipient.verify(message.recipients[i]);
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
        WelcomeFrame.fromObject = function fromObject(object) {
            if (object instanceof $root.canari.WelcomeFrame)
                return object;
            let message = new $root.canari.WelcomeFrame();
            if (object.ciphertext != null)
                if (typeof object.ciphertext === "string")
                    $util.base64.decode(object.ciphertext, message.ciphertext = $util.newBuffer($util.base64.length(object.ciphertext)), 0);
                else if (object.ciphertext.length >= 0)
                    message.ciphertext = object.ciphertext;
            if (object.groupId != null)
                message.groupId = String(object.groupId);
            if (object.recipients) {
                if (!Array.isArray(object.recipients))
                    throw TypeError(".canari.WelcomeFrame.recipients: array expected");
                message.recipients = [];
                for (let i = 0; i < object.recipients.length; ++i) {
                    if (typeof object.recipients[i] !== "object")
                        throw TypeError(".canari.WelcomeFrame.recipients: object expected");
                    message.recipients[i] = $root.canari.Recipient.fromObject(object.recipients[i]);
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
        WelcomeFrame.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.arrays || options.defaults)
                object.recipients = [];
            if (options.defaults) {
                if (options.bytes === String)
                    object.ciphertext = "";
                else {
                    object.ciphertext = [];
                    if (options.bytes !== Array)
                        object.ciphertext = $util.newBuffer(object.ciphertext);
                }
                object.groupId = "";
            }
            if (message.ciphertext != null && message.hasOwnProperty("ciphertext"))
                object.ciphertext = options.bytes === String ? $util.base64.encode(message.ciphertext, 0, message.ciphertext.length) : options.bytes === Array ? Array.prototype.slice.call(message.ciphertext) : message.ciphertext;
            if (message.groupId != null && message.hasOwnProperty("groupId"))
                object.groupId = message.groupId;
            if (message.recipients && message.recipients.length) {
                object.recipients = [];
                for (let j = 0; j < message.recipients.length; ++j)
                    object.recipients[j] = $root.canari.Recipient.toObject(message.recipients[j], options);
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
        WelcomeFrame.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for WelcomeFrame
         * @function getTypeUrl
         * @memberof canari.WelcomeFrame
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        WelcomeFrame.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/canari.WelcomeFrame";
        };

        return WelcomeFrame;
    })();

    canari.ReadAck = (function() {

        /**
         * Properties of a ReadAck.
         * @memberof canari
         * @interface IReadAck
         * @property {string|null} [messageId] ReadAck messageId
         */

        /**
         * Constructs a new ReadAck.
         * @memberof canari
         * @classdesc Represents a ReadAck.
         * @implements IReadAck
         * @constructor
         * @param {canari.IReadAck=} [properties] Properties to set
         */
        function ReadAck(properties) {
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

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
         * @param {canari.IReadAck=} [properties] Properties to set
         * @returns {canari.ReadAck} ReadAck instance
         */
        ReadAck.create = function create(properties) {
            return new ReadAck(properties);
        };

        /**
         * Encodes the specified ReadAck message. Does not implicitly {@link canari.ReadAck.verify|verify} messages.
         * @function encode
         * @memberof canari.ReadAck
         * @static
         * @param {canari.IReadAck} message ReadAck message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        ReadAck.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.messageId != null && Object.hasOwnProperty.call(message, "messageId"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.messageId);
            return writer;
        };

        /**
         * Encodes the specified ReadAck message, length delimited. Does not implicitly {@link canari.ReadAck.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.ReadAck
         * @static
         * @param {canari.IReadAck} message ReadAck message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        ReadAck.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a ReadAck message from the specified reader or buffer.
         * @function decode
         * @memberof canari.ReadAck
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.ReadAck} ReadAck
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        ReadAck.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.canari.ReadAck();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.messageId = reader.string();
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a ReadAck message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.ReadAck
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.ReadAck} ReadAck
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        ReadAck.decodeDelimited = function decodeDelimited(reader) {
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
        ReadAck.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.messageId != null && message.hasOwnProperty("messageId"))
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
        ReadAck.fromObject = function fromObject(object) {
            if (object instanceof $root.canari.ReadAck)
                return object;
            let message = new $root.canari.ReadAck();
            if (object.messageId != null)
                message.messageId = String(object.messageId);
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
        ReadAck.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.defaults)
                object.messageId = "";
            if (message.messageId != null && message.hasOwnProperty("messageId"))
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
        ReadAck.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for ReadAck
         * @function getTypeUrl
         * @memberof canari.ReadAck
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        ReadAck.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/canari.ReadAck";
        };

        return ReadAck;
    })();

    canari.InboundMsg = (function() {

        /**
         * Properties of an InboundMsg.
         * @memberof canari
         * @interface IInboundMsg
         * @property {Uint8Array|null} [ciphertext] InboundMsg ciphertext
         * @property {string|null} [senderId] InboundMsg senderId
         * @property {string|null} [senderDeviceId] InboundMsg senderDeviceId
         * @property {string|null} [groupId] InboundMsg groupId
         * @property {boolean|null} [isWelcome] InboundMsg isWelcome
         */

        /**
         * Constructs a new InboundMsg.
         * @memberof canari
         * @classdesc Represents an InboundMsg.
         * @implements IInboundMsg
         * @constructor
         * @param {canari.IInboundMsg=} [properties] Properties to set
         */
        function InboundMsg(properties) {
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

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
         * Creates a new InboundMsg instance using the specified properties.
         * @function create
         * @memberof canari.InboundMsg
         * @static
         * @param {canari.IInboundMsg=} [properties] Properties to set
         * @returns {canari.InboundMsg} InboundMsg instance
         */
        InboundMsg.create = function create(properties) {
            return new InboundMsg(properties);
        };

        /**
         * Encodes the specified InboundMsg message. Does not implicitly {@link canari.InboundMsg.verify|verify} messages.
         * @function encode
         * @memberof canari.InboundMsg
         * @static
         * @param {canari.IInboundMsg} message InboundMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        InboundMsg.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.ciphertext != null && Object.hasOwnProperty.call(message, "ciphertext"))
                writer.uint32(/* id 1, wireType 2 =*/10).bytes(message.ciphertext);
            if (message.senderId != null && Object.hasOwnProperty.call(message, "senderId"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.senderId);
            if (message.senderDeviceId != null && Object.hasOwnProperty.call(message, "senderDeviceId"))
                writer.uint32(/* id 3, wireType 2 =*/26).string(message.senderDeviceId);
            if (message.groupId != null && Object.hasOwnProperty.call(message, "groupId"))
                writer.uint32(/* id 4, wireType 2 =*/34).string(message.groupId);
            if (message.isWelcome != null && Object.hasOwnProperty.call(message, "isWelcome"))
                writer.uint32(/* id 5, wireType 0 =*/40).bool(message.isWelcome);
            return writer;
        };

        /**
         * Encodes the specified InboundMsg message, length delimited. Does not implicitly {@link canari.InboundMsg.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.InboundMsg
         * @static
         * @param {canari.IInboundMsg} message InboundMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        InboundMsg.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes an InboundMsg message from the specified reader or buffer.
         * @function decode
         * @memberof canari.InboundMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.InboundMsg} InboundMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        InboundMsg.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.canari.InboundMsg();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.ciphertext = reader.bytes();
                        break;
                    }
                case 2: {
                        message.senderId = reader.string();
                        break;
                    }
                case 3: {
                        message.senderDeviceId = reader.string();
                        break;
                    }
                case 4: {
                        message.groupId = reader.string();
                        break;
                    }
                case 5: {
                        message.isWelcome = reader.bool();
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes an InboundMsg message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.InboundMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.InboundMsg} InboundMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        InboundMsg.decodeDelimited = function decodeDelimited(reader) {
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
        InboundMsg.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.ciphertext != null && message.hasOwnProperty("ciphertext"))
                if (!(message.ciphertext && typeof message.ciphertext.length === "number" || $util.isString(message.ciphertext)))
                    return "ciphertext: buffer expected";
            if (message.senderId != null && message.hasOwnProperty("senderId"))
                if (!$util.isString(message.senderId))
                    return "senderId: string expected";
            if (message.senderDeviceId != null && message.hasOwnProperty("senderDeviceId"))
                if (!$util.isString(message.senderDeviceId))
                    return "senderDeviceId: string expected";
            if (message.groupId != null && message.hasOwnProperty("groupId"))
                if (!$util.isString(message.groupId))
                    return "groupId: string expected";
            if (message.isWelcome != null && message.hasOwnProperty("isWelcome"))
                if (typeof message.isWelcome !== "boolean")
                    return "isWelcome: boolean expected";
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
        InboundMsg.fromObject = function fromObject(object) {
            if (object instanceof $root.canari.InboundMsg)
                return object;
            let message = new $root.canari.InboundMsg();
            if (object.ciphertext != null)
                if (typeof object.ciphertext === "string")
                    $util.base64.decode(object.ciphertext, message.ciphertext = $util.newBuffer($util.base64.length(object.ciphertext)), 0);
                else if (object.ciphertext.length >= 0)
                    message.ciphertext = object.ciphertext;
            if (object.senderId != null)
                message.senderId = String(object.senderId);
            if (object.senderDeviceId != null)
                message.senderDeviceId = String(object.senderDeviceId);
            if (object.groupId != null)
                message.groupId = String(object.groupId);
            if (object.isWelcome != null)
                message.isWelcome = Boolean(object.isWelcome);
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
        InboundMsg.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.defaults) {
                if (options.bytes === String)
                    object.ciphertext = "";
                else {
                    object.ciphertext = [];
                    if (options.bytes !== Array)
                        object.ciphertext = $util.newBuffer(object.ciphertext);
                }
                object.senderId = "";
                object.senderDeviceId = "";
                object.groupId = "";
                object.isWelcome = false;
            }
            if (message.ciphertext != null && message.hasOwnProperty("ciphertext"))
                object.ciphertext = options.bytes === String ? $util.base64.encode(message.ciphertext, 0, message.ciphertext.length) : options.bytes === Array ? Array.prototype.slice.call(message.ciphertext) : message.ciphertext;
            if (message.senderId != null && message.hasOwnProperty("senderId"))
                object.senderId = message.senderId;
            if (message.senderDeviceId != null && message.hasOwnProperty("senderDeviceId"))
                object.senderDeviceId = message.senderDeviceId;
            if (message.groupId != null && message.hasOwnProperty("groupId"))
                object.groupId = message.groupId;
            if (message.isWelcome != null && message.hasOwnProperty("isWelcome"))
                object.isWelcome = message.isWelcome;
            return object;
        };

        /**
         * Converts this InboundMsg to JSON.
         * @function toJSON
         * @memberof canari.InboundMsg
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        InboundMsg.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for InboundMsg
         * @function getTypeUrl
         * @memberof canari.InboundMsg
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        InboundMsg.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/canari.InboundMsg";
        };

        return InboundMsg;
    })();

    canari.AppMessage = (function() {

        /**
         * Properties of an AppMessage.
         * @memberof canari
         * @interface IAppMessage
         * @property {string|null} [messageId] AppMessage messageId
         * @property {canari.ITextMsg|null} [text] AppMessage text
         * @property {canari.IReplyMsg|null} [reply] AppMessage reply
         * @property {canari.IReactionMsg|null} [reaction] AppMessage reaction
         * @property {canari.IMediaMsg|null} [media] AppMessage media
         * @property {canari.ISystemMsg|null} [system] AppMessage system
         * @property {canari.ICallMsg|null} [call] AppMessage call
         */

        /**
         * Constructs a new AppMessage.
         * @memberof canari
         * @classdesc Represents an AppMessage.
         * @implements IAppMessage
         * @constructor
         * @param {canari.IAppMessage=} [properties] Properties to set
         */
        function AppMessage(properties) {
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * AppMessage messageId.
         * @member {string} messageId
         * @memberof canari.AppMessage
         * @instance
         */
        AppMessage.prototype.messageId = "";

        /**
         * AppMessage text.
         * @member {canari.ITextMsg|null|undefined} text
         * @memberof canari.AppMessage
         * @instance
         */
        AppMessage.prototype.text = null;

        /**
         * AppMessage reply.
         * @member {canari.IReplyMsg|null|undefined} reply
         * @memberof canari.AppMessage
         * @instance
         */
        AppMessage.prototype.reply = null;

        /**
         * AppMessage reaction.
         * @member {canari.IReactionMsg|null|undefined} reaction
         * @memberof canari.AppMessage
         * @instance
         */
        AppMessage.prototype.reaction = null;

        /**
         * AppMessage media.
         * @member {canari.IMediaMsg|null|undefined} media
         * @memberof canari.AppMessage
         * @instance
         */
        AppMessage.prototype.media = null;

        /**
         * AppMessage system.
         * @member {canari.ISystemMsg|null|undefined} system
         * @memberof canari.AppMessage
         * @instance
         */
        AppMessage.prototype.system = null;

        /**
         * AppMessage call.
         * @member {canari.ICallMsg|null|undefined} call
         * @memberof canari.AppMessage
         * @instance
         */
        AppMessage.prototype.call = null;

        // OneOf field names bound to virtual getters and setters
        let $oneOfFields;

        /**
         * AppMessage kind.
         * @member {"text"|"reply"|"reaction"|"media"|"system"|"call"|undefined} kind
         * @memberof canari.AppMessage
         * @instance
         */
        Object.defineProperty(AppMessage.prototype, "kind", {
            get: $util.oneOfGetter($oneOfFields = ["text", "reply", "reaction", "media", "system", "call"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        /**
         * Creates a new AppMessage instance using the specified properties.
         * @function create
         * @memberof canari.AppMessage
         * @static
         * @param {canari.IAppMessage=} [properties] Properties to set
         * @returns {canari.AppMessage} AppMessage instance
         */
        AppMessage.create = function create(properties) {
            return new AppMessage(properties);
        };

        /**
         * Encodes the specified AppMessage message. Does not implicitly {@link canari.AppMessage.verify|verify} messages.
         * @function encode
         * @memberof canari.AppMessage
         * @static
         * @param {canari.IAppMessage} message AppMessage message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        AppMessage.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.text != null && Object.hasOwnProperty.call(message, "text"))
                $root.canari.TextMsg.encode(message.text, writer.uint32(/* id 1, wireType 2 =*/10).fork()).ldelim();
            if (message.reply != null && Object.hasOwnProperty.call(message, "reply"))
                $root.canari.ReplyMsg.encode(message.reply, writer.uint32(/* id 2, wireType 2 =*/18).fork()).ldelim();
            if (message.reaction != null && Object.hasOwnProperty.call(message, "reaction"))
                $root.canari.ReactionMsg.encode(message.reaction, writer.uint32(/* id 3, wireType 2 =*/26).fork()).ldelim();
            if (message.media != null && Object.hasOwnProperty.call(message, "media"))
                $root.canari.MediaMsg.encode(message.media, writer.uint32(/* id 4, wireType 2 =*/34).fork()).ldelim();
            if (message.system != null && Object.hasOwnProperty.call(message, "system"))
                $root.canari.SystemMsg.encode(message.system, writer.uint32(/* id 5, wireType 2 =*/42).fork()).ldelim();
            if (message.messageId != null && Object.hasOwnProperty.call(message, "messageId"))
                writer.uint32(/* id 6, wireType 2 =*/50).string(message.messageId);
            if (message.call != null && Object.hasOwnProperty.call(message, "call"))
                $root.canari.CallMsg.encode(message.call, writer.uint32(/* id 7, wireType 2 =*/58).fork()).ldelim();
            return writer;
        };

        /**
         * Encodes the specified AppMessage message, length delimited. Does not implicitly {@link canari.AppMessage.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.AppMessage
         * @static
         * @param {canari.IAppMessage} message AppMessage message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        AppMessage.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes an AppMessage message from the specified reader or buffer.
         * @function decode
         * @memberof canari.AppMessage
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.AppMessage} AppMessage
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        AppMessage.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.canari.AppMessage();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 6: {
                        message.messageId = reader.string();
                        break;
                    }
                case 1: {
                        message.text = $root.canari.TextMsg.decode(reader, reader.uint32());
                        break;
                    }
                case 2: {
                        message.reply = $root.canari.ReplyMsg.decode(reader, reader.uint32());
                        break;
                    }
                case 3: {
                        message.reaction = $root.canari.ReactionMsg.decode(reader, reader.uint32());
                        break;
                    }
                case 4: {
                        message.media = $root.canari.MediaMsg.decode(reader, reader.uint32());
                        break;
                    }
                case 5: {
                        message.system = $root.canari.SystemMsg.decode(reader, reader.uint32());
                        break;
                    }
                case 7: {
                        message.call = $root.canari.CallMsg.decode(reader, reader.uint32());
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes an AppMessage message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.AppMessage
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.AppMessage} AppMessage
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        AppMessage.decodeDelimited = function decodeDelimited(reader) {
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
        AppMessage.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            let properties = {};
            if (message.messageId != null && message.hasOwnProperty("messageId"))
                if (!$util.isString(message.messageId))
                    return "messageId: string expected";
            if (message.text != null && message.hasOwnProperty("text")) {
                properties.kind = 1;
                {
                    let error = $root.canari.TextMsg.verify(message.text);
                    if (error)
                        return "text." + error;
                }
            }
            if (message.reply != null && message.hasOwnProperty("reply")) {
                if (properties.kind === 1)
                    return "kind: multiple values";
                properties.kind = 1;
                {
                    let error = $root.canari.ReplyMsg.verify(message.reply);
                    if (error)
                        return "reply." + error;
                }
            }
            if (message.reaction != null && message.hasOwnProperty("reaction")) {
                if (properties.kind === 1)
                    return "kind: multiple values";
                properties.kind = 1;
                {
                    let error = $root.canari.ReactionMsg.verify(message.reaction);
                    if (error)
                        return "reaction." + error;
                }
            }
            if (message.media != null && message.hasOwnProperty("media")) {
                if (properties.kind === 1)
                    return "kind: multiple values";
                properties.kind = 1;
                {
                    let error = $root.canari.MediaMsg.verify(message.media);
                    if (error)
                        return "media." + error;
                }
            }
            if (message.system != null && message.hasOwnProperty("system")) {
                if (properties.kind === 1)
                    return "kind: multiple values";
                properties.kind = 1;
                {
                    let error = $root.canari.SystemMsg.verify(message.system);
                    if (error)
                        return "system." + error;
                }
            }
            if (message.call != null && message.hasOwnProperty("call")) {
                if (properties.kind === 1)
                    return "kind: multiple values";
                properties.kind = 1;
                {
                    let error = $root.canari.CallMsg.verify(message.call);
                    if (error)
                        return "call." + error;
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
        AppMessage.fromObject = function fromObject(object) {
            if (object instanceof $root.canari.AppMessage)
                return object;
            let message = new $root.canari.AppMessage();
            if (object.messageId != null)
                message.messageId = String(object.messageId);
            if (object.text != null) {
                if (typeof object.text !== "object")
                    throw TypeError(".canari.AppMessage.text: object expected");
                message.text = $root.canari.TextMsg.fromObject(object.text);
            }
            if (object.reply != null) {
                if (typeof object.reply !== "object")
                    throw TypeError(".canari.AppMessage.reply: object expected");
                message.reply = $root.canari.ReplyMsg.fromObject(object.reply);
            }
            if (object.reaction != null) {
                if (typeof object.reaction !== "object")
                    throw TypeError(".canari.AppMessage.reaction: object expected");
                message.reaction = $root.canari.ReactionMsg.fromObject(object.reaction);
            }
            if (object.media != null) {
                if (typeof object.media !== "object")
                    throw TypeError(".canari.AppMessage.media: object expected");
                message.media = $root.canari.MediaMsg.fromObject(object.media);
            }
            if (object.system != null) {
                if (typeof object.system !== "object")
                    throw TypeError(".canari.AppMessage.system: object expected");
                message.system = $root.canari.SystemMsg.fromObject(object.system);
            }
            if (object.call != null) {
                if (typeof object.call !== "object")
                    throw TypeError(".canari.AppMessage.call: object expected");
                message.call = $root.canari.CallMsg.fromObject(object.call);
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
        AppMessage.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.defaults)
                object.messageId = "";
            if (message.text != null && message.hasOwnProperty("text")) {
                object.text = $root.canari.TextMsg.toObject(message.text, options);
                if (options.oneofs)
                    object.kind = "text";
            }
            if (message.reply != null && message.hasOwnProperty("reply")) {
                object.reply = $root.canari.ReplyMsg.toObject(message.reply, options);
                if (options.oneofs)
                    object.kind = "reply";
            }
            if (message.reaction != null && message.hasOwnProperty("reaction")) {
                object.reaction = $root.canari.ReactionMsg.toObject(message.reaction, options);
                if (options.oneofs)
                    object.kind = "reaction";
            }
            if (message.media != null && message.hasOwnProperty("media")) {
                object.media = $root.canari.MediaMsg.toObject(message.media, options);
                if (options.oneofs)
                    object.kind = "media";
            }
            if (message.system != null && message.hasOwnProperty("system")) {
                object.system = $root.canari.SystemMsg.toObject(message.system, options);
                if (options.oneofs)
                    object.kind = "system";
            }
            if (message.messageId != null && message.hasOwnProperty("messageId"))
                object.messageId = message.messageId;
            if (message.call != null && message.hasOwnProperty("call")) {
                object.call = $root.canari.CallMsg.toObject(message.call, options);
                if (options.oneofs)
                    object.kind = "call";
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
        AppMessage.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for AppMessage
         * @function getTypeUrl
         * @memberof canari.AppMessage
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        AppMessage.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/canari.AppMessage";
        };

        return AppMessage;
    })();

    canari.CallMsg = (function() {

        /**
         * Properties of a CallMsg.
         * @memberof canari
         * @interface ICallMsg
         * @property {string|null} [callId] CallMsg callId
         * @property {string|null} [offerSdp] CallMsg offerSdp
         * @property {string|null} [answerSdp] CallMsg answerSdp
         * @property {string|null} [iceCandidate] CallMsg iceCandidate
         * @property {boolean|null} [hangup] CallMsg hangup
         */

        /**
         * Constructs a new CallMsg.
         * @memberof canari
         * @classdesc Represents a CallMsg.
         * @implements ICallMsg
         * @constructor
         * @param {canari.ICallMsg=} [properties] Properties to set
         */
        function CallMsg(properties) {
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * CallMsg callId.
         * @member {string} callId
         * @memberof canari.CallMsg
         * @instance
         */
        CallMsg.prototype.callId = "";

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

        // OneOf field names bound to virtual getters and setters
        let $oneOfFields;

        /**
         * CallMsg payload.
         * @member {"offerSdp"|"answerSdp"|"iceCandidate"|"hangup"|undefined} payload
         * @memberof canari.CallMsg
         * @instance
         */
        Object.defineProperty(CallMsg.prototype, "payload", {
            get: $util.oneOfGetter($oneOfFields = ["offerSdp", "answerSdp", "iceCandidate", "hangup"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        /**
         * Creates a new CallMsg instance using the specified properties.
         * @function create
         * @memberof canari.CallMsg
         * @static
         * @param {canari.ICallMsg=} [properties] Properties to set
         * @returns {canari.CallMsg} CallMsg instance
         */
        CallMsg.create = function create(properties) {
            return new CallMsg(properties);
        };

        /**
         * Encodes the specified CallMsg message. Does not implicitly {@link canari.CallMsg.verify|verify} messages.
         * @function encode
         * @memberof canari.CallMsg
         * @static
         * @param {canari.ICallMsg} message CallMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        CallMsg.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.callId != null && Object.hasOwnProperty.call(message, "callId"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.callId);
            if (message.offerSdp != null && Object.hasOwnProperty.call(message, "offerSdp"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.offerSdp);
            if (message.answerSdp != null && Object.hasOwnProperty.call(message, "answerSdp"))
                writer.uint32(/* id 3, wireType 2 =*/26).string(message.answerSdp);
            if (message.iceCandidate != null && Object.hasOwnProperty.call(message, "iceCandidate"))
                writer.uint32(/* id 4, wireType 2 =*/34).string(message.iceCandidate);
            if (message.hangup != null && Object.hasOwnProperty.call(message, "hangup"))
                writer.uint32(/* id 5, wireType 0 =*/40).bool(message.hangup);
            return writer;
        };

        /**
         * Encodes the specified CallMsg message, length delimited. Does not implicitly {@link canari.CallMsg.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.CallMsg
         * @static
         * @param {canari.ICallMsg} message CallMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        CallMsg.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a CallMsg message from the specified reader or buffer.
         * @function decode
         * @memberof canari.CallMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.CallMsg} CallMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        CallMsg.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.canari.CallMsg();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.callId = reader.string();
                        break;
                    }
                case 2: {
                        message.offerSdp = reader.string();
                        break;
                    }
                case 3: {
                        message.answerSdp = reader.string();
                        break;
                    }
                case 4: {
                        message.iceCandidate = reader.string();
                        break;
                    }
                case 5: {
                        message.hangup = reader.bool();
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a CallMsg message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.CallMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.CallMsg} CallMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        CallMsg.decodeDelimited = function decodeDelimited(reader) {
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
        CallMsg.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            let properties = {};
            if (message.callId != null && message.hasOwnProperty("callId"))
                if (!$util.isString(message.callId))
                    return "callId: string expected";
            if (message.offerSdp != null && message.hasOwnProperty("offerSdp")) {
                properties.payload = 1;
                if (!$util.isString(message.offerSdp))
                    return "offerSdp: string expected";
            }
            if (message.answerSdp != null && message.hasOwnProperty("answerSdp")) {
                if (properties.payload === 1)
                    return "payload: multiple values";
                properties.payload = 1;
                if (!$util.isString(message.answerSdp))
                    return "answerSdp: string expected";
            }
            if (message.iceCandidate != null && message.hasOwnProperty("iceCandidate")) {
                if (properties.payload === 1)
                    return "payload: multiple values";
                properties.payload = 1;
                if (!$util.isString(message.iceCandidate))
                    return "iceCandidate: string expected";
            }
            if (message.hangup != null && message.hasOwnProperty("hangup")) {
                if (properties.payload === 1)
                    return "payload: multiple values";
                properties.payload = 1;
                if (typeof message.hangup !== "boolean")
                    return "hangup: boolean expected";
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
        CallMsg.fromObject = function fromObject(object) {
            if (object instanceof $root.canari.CallMsg)
                return object;
            let message = new $root.canari.CallMsg();
            if (object.callId != null)
                message.callId = String(object.callId);
            if (object.offerSdp != null)
                message.offerSdp = String(object.offerSdp);
            if (object.answerSdp != null)
                message.answerSdp = String(object.answerSdp);
            if (object.iceCandidate != null)
                message.iceCandidate = String(object.iceCandidate);
            if (object.hangup != null)
                message.hangup = Boolean(object.hangup);
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
        CallMsg.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.defaults)
                object.callId = "";
            if (message.callId != null && message.hasOwnProperty("callId"))
                object.callId = message.callId;
            if (message.offerSdp != null && message.hasOwnProperty("offerSdp")) {
                object.offerSdp = message.offerSdp;
                if (options.oneofs)
                    object.payload = "offerSdp";
            }
            if (message.answerSdp != null && message.hasOwnProperty("answerSdp")) {
                object.answerSdp = message.answerSdp;
                if (options.oneofs)
                    object.payload = "answerSdp";
            }
            if (message.iceCandidate != null && message.hasOwnProperty("iceCandidate")) {
                object.iceCandidate = message.iceCandidate;
                if (options.oneofs)
                    object.payload = "iceCandidate";
            }
            if (message.hangup != null && message.hasOwnProperty("hangup")) {
                object.hangup = message.hangup;
                if (options.oneofs)
                    object.payload = "hangup";
            }
            return object;
        };

        /**
         * Converts this CallMsg to JSON.
         * @function toJSON
         * @memberof canari.CallMsg
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        CallMsg.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for CallMsg
         * @function getTypeUrl
         * @memberof canari.CallMsg
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        CallMsg.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/canari.CallMsg";
        };

        return CallMsg;
    })();

    canari.TextMsg = (function() {

        /**
         * Properties of a TextMsg.
         * @memberof canari
         * @interface ITextMsg
         * @property {string|null} [content] TextMsg content
         */

        /**
         * Constructs a new TextMsg.
         * @memberof canari
         * @classdesc Represents a TextMsg.
         * @implements ITextMsg
         * @constructor
         * @param {canari.ITextMsg=} [properties] Properties to set
         */
        function TextMsg(properties) {
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

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
         * @param {canari.ITextMsg=} [properties] Properties to set
         * @returns {canari.TextMsg} TextMsg instance
         */
        TextMsg.create = function create(properties) {
            return new TextMsg(properties);
        };

        /**
         * Encodes the specified TextMsg message. Does not implicitly {@link canari.TextMsg.verify|verify} messages.
         * @function encode
         * @memberof canari.TextMsg
         * @static
         * @param {canari.ITextMsg} message TextMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        TextMsg.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.content != null && Object.hasOwnProperty.call(message, "content"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.content);
            return writer;
        };

        /**
         * Encodes the specified TextMsg message, length delimited. Does not implicitly {@link canari.TextMsg.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.TextMsg
         * @static
         * @param {canari.ITextMsg} message TextMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        TextMsg.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a TextMsg message from the specified reader or buffer.
         * @function decode
         * @memberof canari.TextMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.TextMsg} TextMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        TextMsg.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.canari.TextMsg();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.content = reader.string();
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a TextMsg message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.TextMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.TextMsg} TextMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        TextMsg.decodeDelimited = function decodeDelimited(reader) {
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
        TextMsg.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.content != null && message.hasOwnProperty("content"))
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
        TextMsg.fromObject = function fromObject(object) {
            if (object instanceof $root.canari.TextMsg)
                return object;
            let message = new $root.canari.TextMsg();
            if (object.content != null)
                message.content = String(object.content);
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
        TextMsg.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.defaults)
                object.content = "";
            if (message.content != null && message.hasOwnProperty("content"))
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
        TextMsg.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for TextMsg
         * @function getTypeUrl
         * @memberof canari.TextMsg
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        TextMsg.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/canari.TextMsg";
        };

        return TextMsg;
    })();

    canari.ReplyRef = (function() {

        /**
         * Properties of a ReplyRef.
         * @memberof canari
         * @interface IReplyRef
         * @property {string|null} [id] ReplyRef id
         * @property {string|null} [senderId] ReplyRef senderId
         * @property {string|null} [preview] ReplyRef preview
         */

        /**
         * Constructs a new ReplyRef.
         * @memberof canari
         * @classdesc Represents a ReplyRef.
         * @implements IReplyRef
         * @constructor
         * @param {canari.IReplyRef=} [properties] Properties to set
         */
        function ReplyRef(properties) {
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

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
         * @param {canari.IReplyRef=} [properties] Properties to set
         * @returns {canari.ReplyRef} ReplyRef instance
         */
        ReplyRef.create = function create(properties) {
            return new ReplyRef(properties);
        };

        /**
         * Encodes the specified ReplyRef message. Does not implicitly {@link canari.ReplyRef.verify|verify} messages.
         * @function encode
         * @memberof canari.ReplyRef
         * @static
         * @param {canari.IReplyRef} message ReplyRef message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        ReplyRef.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.id != null && Object.hasOwnProperty.call(message, "id"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.id);
            if (message.senderId != null && Object.hasOwnProperty.call(message, "senderId"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.senderId);
            if (message.preview != null && Object.hasOwnProperty.call(message, "preview"))
                writer.uint32(/* id 3, wireType 2 =*/26).string(message.preview);
            return writer;
        };

        /**
         * Encodes the specified ReplyRef message, length delimited. Does not implicitly {@link canari.ReplyRef.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.ReplyRef
         * @static
         * @param {canari.IReplyRef} message ReplyRef message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        ReplyRef.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a ReplyRef message from the specified reader or buffer.
         * @function decode
         * @memberof canari.ReplyRef
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.ReplyRef} ReplyRef
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        ReplyRef.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.canari.ReplyRef();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.id = reader.string();
                        break;
                    }
                case 2: {
                        message.senderId = reader.string();
                        break;
                    }
                case 3: {
                        message.preview = reader.string();
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a ReplyRef message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.ReplyRef
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.ReplyRef} ReplyRef
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        ReplyRef.decodeDelimited = function decodeDelimited(reader) {
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
        ReplyRef.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.id != null && message.hasOwnProperty("id"))
                if (!$util.isString(message.id))
                    return "id: string expected";
            if (message.senderId != null && message.hasOwnProperty("senderId"))
                if (!$util.isString(message.senderId))
                    return "senderId: string expected";
            if (message.preview != null && message.hasOwnProperty("preview"))
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
        ReplyRef.fromObject = function fromObject(object) {
            if (object instanceof $root.canari.ReplyRef)
                return object;
            let message = new $root.canari.ReplyRef();
            if (object.id != null)
                message.id = String(object.id);
            if (object.senderId != null)
                message.senderId = String(object.senderId);
            if (object.preview != null)
                message.preview = String(object.preview);
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
        ReplyRef.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.defaults) {
                object.id = "";
                object.senderId = "";
                object.preview = "";
            }
            if (message.id != null && message.hasOwnProperty("id"))
                object.id = message.id;
            if (message.senderId != null && message.hasOwnProperty("senderId"))
                object.senderId = message.senderId;
            if (message.preview != null && message.hasOwnProperty("preview"))
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
        ReplyRef.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for ReplyRef
         * @function getTypeUrl
         * @memberof canari.ReplyRef
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        ReplyRef.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/canari.ReplyRef";
        };

        return ReplyRef;
    })();

    canari.ReplyMsg = (function() {

        /**
         * Properties of a ReplyMsg.
         * @memberof canari
         * @interface IReplyMsg
         * @property {string|null} [content] ReplyMsg content
         * @property {canari.IReplyRef|null} [replyTo] ReplyMsg replyTo
         */

        /**
         * Constructs a new ReplyMsg.
         * @memberof canari
         * @classdesc Represents a ReplyMsg.
         * @implements IReplyMsg
         * @constructor
         * @param {canari.IReplyMsg=} [properties] Properties to set
         */
        function ReplyMsg(properties) {
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * ReplyMsg content.
         * @member {string} content
         * @memberof canari.ReplyMsg
         * @instance
         */
        ReplyMsg.prototype.content = "";

        /**
         * ReplyMsg replyTo.
         * @member {canari.IReplyRef|null|undefined} replyTo
         * @memberof canari.ReplyMsg
         * @instance
         */
        ReplyMsg.prototype.replyTo = null;

        /**
         * Creates a new ReplyMsg instance using the specified properties.
         * @function create
         * @memberof canari.ReplyMsg
         * @static
         * @param {canari.IReplyMsg=} [properties] Properties to set
         * @returns {canari.ReplyMsg} ReplyMsg instance
         */
        ReplyMsg.create = function create(properties) {
            return new ReplyMsg(properties);
        };

        /**
         * Encodes the specified ReplyMsg message. Does not implicitly {@link canari.ReplyMsg.verify|verify} messages.
         * @function encode
         * @memberof canari.ReplyMsg
         * @static
         * @param {canari.IReplyMsg} message ReplyMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        ReplyMsg.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.content != null && Object.hasOwnProperty.call(message, "content"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.content);
            if (message.replyTo != null && Object.hasOwnProperty.call(message, "replyTo"))
                $root.canari.ReplyRef.encode(message.replyTo, writer.uint32(/* id 2, wireType 2 =*/18).fork()).ldelim();
            return writer;
        };

        /**
         * Encodes the specified ReplyMsg message, length delimited. Does not implicitly {@link canari.ReplyMsg.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.ReplyMsg
         * @static
         * @param {canari.IReplyMsg} message ReplyMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        ReplyMsg.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a ReplyMsg message from the specified reader or buffer.
         * @function decode
         * @memberof canari.ReplyMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.ReplyMsg} ReplyMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        ReplyMsg.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.canari.ReplyMsg();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.content = reader.string();
                        break;
                    }
                case 2: {
                        message.replyTo = $root.canari.ReplyRef.decode(reader, reader.uint32());
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a ReplyMsg message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.ReplyMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.ReplyMsg} ReplyMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        ReplyMsg.decodeDelimited = function decodeDelimited(reader) {
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
        ReplyMsg.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.content != null && message.hasOwnProperty("content"))
                if (!$util.isString(message.content))
                    return "content: string expected";
            if (message.replyTo != null && message.hasOwnProperty("replyTo")) {
                let error = $root.canari.ReplyRef.verify(message.replyTo);
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
        ReplyMsg.fromObject = function fromObject(object) {
            if (object instanceof $root.canari.ReplyMsg)
                return object;
            let message = new $root.canari.ReplyMsg();
            if (object.content != null)
                message.content = String(object.content);
            if (object.replyTo != null) {
                if (typeof object.replyTo !== "object")
                    throw TypeError(".canari.ReplyMsg.replyTo: object expected");
                message.replyTo = $root.canari.ReplyRef.fromObject(object.replyTo);
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
        ReplyMsg.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.defaults) {
                object.content = "";
                object.replyTo = null;
            }
            if (message.content != null && message.hasOwnProperty("content"))
                object.content = message.content;
            if (message.replyTo != null && message.hasOwnProperty("replyTo"))
                object.replyTo = $root.canari.ReplyRef.toObject(message.replyTo, options);
            return object;
        };

        /**
         * Converts this ReplyMsg to JSON.
         * @function toJSON
         * @memberof canari.ReplyMsg
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        ReplyMsg.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for ReplyMsg
         * @function getTypeUrl
         * @memberof canari.ReplyMsg
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        ReplyMsg.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/canari.ReplyMsg";
        };

        return ReplyMsg;
    })();

    canari.ReactionMsg = (function() {

        /**
         * Properties of a ReactionMsg.
         * @memberof canari
         * @interface IReactionMsg
         * @property {string|null} [messageId] ReactionMsg messageId
         * @property {string|null} [emoji] ReactionMsg emoji
         */

        /**
         * Constructs a new ReactionMsg.
         * @memberof canari
         * @classdesc Represents a ReactionMsg.
         * @implements IReactionMsg
         * @constructor
         * @param {canari.IReactionMsg=} [properties] Properties to set
         */
        function ReactionMsg(properties) {
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

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
         * @param {canari.IReactionMsg=} [properties] Properties to set
         * @returns {canari.ReactionMsg} ReactionMsg instance
         */
        ReactionMsg.create = function create(properties) {
            return new ReactionMsg(properties);
        };

        /**
         * Encodes the specified ReactionMsg message. Does not implicitly {@link canari.ReactionMsg.verify|verify} messages.
         * @function encode
         * @memberof canari.ReactionMsg
         * @static
         * @param {canari.IReactionMsg} message ReactionMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        ReactionMsg.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.messageId != null && Object.hasOwnProperty.call(message, "messageId"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.messageId);
            if (message.emoji != null && Object.hasOwnProperty.call(message, "emoji"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.emoji);
            return writer;
        };

        /**
         * Encodes the specified ReactionMsg message, length delimited. Does not implicitly {@link canari.ReactionMsg.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.ReactionMsg
         * @static
         * @param {canari.IReactionMsg} message ReactionMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        ReactionMsg.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a ReactionMsg message from the specified reader or buffer.
         * @function decode
         * @memberof canari.ReactionMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.ReactionMsg} ReactionMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        ReactionMsg.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.canari.ReactionMsg();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.messageId = reader.string();
                        break;
                    }
                case 2: {
                        message.emoji = reader.string();
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a ReactionMsg message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.ReactionMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.ReactionMsg} ReactionMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        ReactionMsg.decodeDelimited = function decodeDelimited(reader) {
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
        ReactionMsg.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.messageId != null && message.hasOwnProperty("messageId"))
                if (!$util.isString(message.messageId))
                    return "messageId: string expected";
            if (message.emoji != null && message.hasOwnProperty("emoji"))
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
        ReactionMsg.fromObject = function fromObject(object) {
            if (object instanceof $root.canari.ReactionMsg)
                return object;
            let message = new $root.canari.ReactionMsg();
            if (object.messageId != null)
                message.messageId = String(object.messageId);
            if (object.emoji != null)
                message.emoji = String(object.emoji);
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
        ReactionMsg.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.defaults) {
                object.messageId = "";
                object.emoji = "";
            }
            if (message.messageId != null && message.hasOwnProperty("messageId"))
                object.messageId = message.messageId;
            if (message.emoji != null && message.hasOwnProperty("emoji"))
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
        ReactionMsg.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for ReactionMsg
         * @function getTypeUrl
         * @memberof canari.ReactionMsg
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        ReactionMsg.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/canari.ReactionMsg";
        };

        return ReactionMsg;
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
        const valuesById = {}, values = Object.create(valuesById);
        values[valuesById[0] = "MEDIA_FILE"] = 0;
        values[valuesById[1] = "MEDIA_IMAGE"] = 1;
        values[valuesById[2] = "MEDIA_VIDEO"] = 2;
        values[valuesById[3] = "MEDIA_AUDIO"] = 3;
        return values;
    })();

    canari.MediaMsg = (function() {

        /**
         * Properties of a MediaMsg.
         * @memberof canari
         * @interface IMediaMsg
         * @property {canari.MediaKind|null} [kind] MediaMsg kind
         * @property {string|null} [mediaId] MediaMsg mediaId
         * @property {Uint8Array|null} [key] MediaMsg key
         * @property {Uint8Array|null} [iv] MediaMsg iv
         * @property {string|null} [mimeType] MediaMsg mimeType
         * @property {number|null} [size] MediaMsg size
         * @property {string|null} [fileName] MediaMsg fileName
         * @property {string|null} [caption] MediaMsg caption
         */

        /**
         * Constructs a new MediaMsg.
         * @memberof canari
         * @classdesc Represents a MediaMsg.
         * @implements IMediaMsg
         * @constructor
         * @param {canari.IMediaMsg=} [properties] Properties to set
         */
        function MediaMsg(properties) {
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

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
         * Creates a new MediaMsg instance using the specified properties.
         * @function create
         * @memberof canari.MediaMsg
         * @static
         * @param {canari.IMediaMsg=} [properties] Properties to set
         * @returns {canari.MediaMsg} MediaMsg instance
         */
        MediaMsg.create = function create(properties) {
            return new MediaMsg(properties);
        };

        /**
         * Encodes the specified MediaMsg message. Does not implicitly {@link canari.MediaMsg.verify|verify} messages.
         * @function encode
         * @memberof canari.MediaMsg
         * @static
         * @param {canari.IMediaMsg} message MediaMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        MediaMsg.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.kind != null && Object.hasOwnProperty.call(message, "kind"))
                writer.uint32(/* id 1, wireType 0 =*/8).int32(message.kind);
            if (message.mediaId != null && Object.hasOwnProperty.call(message, "mediaId"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.mediaId);
            if (message.key != null && Object.hasOwnProperty.call(message, "key"))
                writer.uint32(/* id 3, wireType 2 =*/26).bytes(message.key);
            if (message.iv != null && Object.hasOwnProperty.call(message, "iv"))
                writer.uint32(/* id 4, wireType 2 =*/34).bytes(message.iv);
            if (message.mimeType != null && Object.hasOwnProperty.call(message, "mimeType"))
                writer.uint32(/* id 5, wireType 2 =*/42).string(message.mimeType);
            if (message.size != null && Object.hasOwnProperty.call(message, "size"))
                writer.uint32(/* id 6, wireType 0 =*/48).uint32(message.size);
            if (message.fileName != null && Object.hasOwnProperty.call(message, "fileName"))
                writer.uint32(/* id 7, wireType 2 =*/58).string(message.fileName);
            if (message.caption != null && Object.hasOwnProperty.call(message, "caption"))
                writer.uint32(/* id 8, wireType 2 =*/66).string(message.caption);
            return writer;
        };

        /**
         * Encodes the specified MediaMsg message, length delimited. Does not implicitly {@link canari.MediaMsg.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.MediaMsg
         * @static
         * @param {canari.IMediaMsg} message MediaMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        MediaMsg.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a MediaMsg message from the specified reader or buffer.
         * @function decode
         * @memberof canari.MediaMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.MediaMsg} MediaMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        MediaMsg.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.canari.MediaMsg();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.kind = reader.int32();
                        break;
                    }
                case 2: {
                        message.mediaId = reader.string();
                        break;
                    }
                case 3: {
                        message.key = reader.bytes();
                        break;
                    }
                case 4: {
                        message.iv = reader.bytes();
                        break;
                    }
                case 5: {
                        message.mimeType = reader.string();
                        break;
                    }
                case 6: {
                        message.size = reader.uint32();
                        break;
                    }
                case 7: {
                        message.fileName = reader.string();
                        break;
                    }
                case 8: {
                        message.caption = reader.string();
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a MediaMsg message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.MediaMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.MediaMsg} MediaMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        MediaMsg.decodeDelimited = function decodeDelimited(reader) {
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
        MediaMsg.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.kind != null && message.hasOwnProperty("kind"))
                switch (message.kind) {
                default:
                    return "kind: enum value expected";
                case 0:
                case 1:
                case 2:
                case 3:
                    break;
                }
            if (message.mediaId != null && message.hasOwnProperty("mediaId"))
                if (!$util.isString(message.mediaId))
                    return "mediaId: string expected";
            if (message.key != null && message.hasOwnProperty("key"))
                if (!(message.key && typeof message.key.length === "number" || $util.isString(message.key)))
                    return "key: buffer expected";
            if (message.iv != null && message.hasOwnProperty("iv"))
                if (!(message.iv && typeof message.iv.length === "number" || $util.isString(message.iv)))
                    return "iv: buffer expected";
            if (message.mimeType != null && message.hasOwnProperty("mimeType"))
                if (!$util.isString(message.mimeType))
                    return "mimeType: string expected";
            if (message.size != null && message.hasOwnProperty("size"))
                if (!$util.isInteger(message.size))
                    return "size: integer expected";
            if (message.fileName != null && message.hasOwnProperty("fileName"))
                if (!$util.isString(message.fileName))
                    return "fileName: string expected";
            if (message.caption != null && message.hasOwnProperty("caption"))
                if (!$util.isString(message.caption))
                    return "caption: string expected";
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
        MediaMsg.fromObject = function fromObject(object) {
            if (object instanceof $root.canari.MediaMsg)
                return object;
            let message = new $root.canari.MediaMsg();
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
                message.mediaId = String(object.mediaId);
            if (object.key != null)
                if (typeof object.key === "string")
                    $util.base64.decode(object.key, message.key = $util.newBuffer($util.base64.length(object.key)), 0);
                else if (object.key.length >= 0)
                    message.key = object.key;
            if (object.iv != null)
                if (typeof object.iv === "string")
                    $util.base64.decode(object.iv, message.iv = $util.newBuffer($util.base64.length(object.iv)), 0);
                else if (object.iv.length >= 0)
                    message.iv = object.iv;
            if (object.mimeType != null)
                message.mimeType = String(object.mimeType);
            if (object.size != null)
                message.size = object.size >>> 0;
            if (object.fileName != null)
                message.fileName = String(object.fileName);
            if (object.caption != null)
                message.caption = String(object.caption);
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
        MediaMsg.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.defaults) {
                object.kind = options.enums === String ? "MEDIA_FILE" : 0;
                object.mediaId = "";
                if (options.bytes === String)
                    object.key = "";
                else {
                    object.key = [];
                    if (options.bytes !== Array)
                        object.key = $util.newBuffer(object.key);
                }
                if (options.bytes === String)
                    object.iv = "";
                else {
                    object.iv = [];
                    if (options.bytes !== Array)
                        object.iv = $util.newBuffer(object.iv);
                }
                object.mimeType = "";
                object.size = 0;
                object.fileName = "";
                object.caption = "";
            }
            if (message.kind != null && message.hasOwnProperty("kind"))
                object.kind = options.enums === String ? $root.canari.MediaKind[message.kind] === undefined ? message.kind : $root.canari.MediaKind[message.kind] : message.kind;
            if (message.mediaId != null && message.hasOwnProperty("mediaId"))
                object.mediaId = message.mediaId;
            if (message.key != null && message.hasOwnProperty("key"))
                object.key = options.bytes === String ? $util.base64.encode(message.key, 0, message.key.length) : options.bytes === Array ? Array.prototype.slice.call(message.key) : message.key;
            if (message.iv != null && message.hasOwnProperty("iv"))
                object.iv = options.bytes === String ? $util.base64.encode(message.iv, 0, message.iv.length) : options.bytes === Array ? Array.prototype.slice.call(message.iv) : message.iv;
            if (message.mimeType != null && message.hasOwnProperty("mimeType"))
                object.mimeType = message.mimeType;
            if (message.size != null && message.hasOwnProperty("size"))
                object.size = message.size;
            if (message.fileName != null && message.hasOwnProperty("fileName"))
                object.fileName = message.fileName;
            if (message.caption != null && message.hasOwnProperty("caption"))
                object.caption = message.caption;
            return object;
        };

        /**
         * Converts this MediaMsg to JSON.
         * @function toJSON
         * @memberof canari.MediaMsg
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        MediaMsg.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for MediaMsg
         * @function getTypeUrl
         * @memberof canari.MediaMsg
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        MediaMsg.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/canari.MediaMsg";
        };

        return MediaMsg;
    })();

    canari.SystemMsg = (function() {

        /**
         * Properties of a SystemMsg.
         * @memberof canari
         * @interface ISystemMsg
         * @property {string|null} [event] SystemMsg event
         * @property {string|null} [data] SystemMsg data
         */

        /**
         * Constructs a new SystemMsg.
         * @memberof canari
         * @classdesc Represents a SystemMsg.
         * @implements ISystemMsg
         * @constructor
         * @param {canari.ISystemMsg=} [properties] Properties to set
         */
        function SystemMsg(properties) {
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

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
         * @param {canari.ISystemMsg=} [properties] Properties to set
         * @returns {canari.SystemMsg} SystemMsg instance
         */
        SystemMsg.create = function create(properties) {
            return new SystemMsg(properties);
        };

        /**
         * Encodes the specified SystemMsg message. Does not implicitly {@link canari.SystemMsg.verify|verify} messages.
         * @function encode
         * @memberof canari.SystemMsg
         * @static
         * @param {canari.ISystemMsg} message SystemMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        SystemMsg.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.event != null && Object.hasOwnProperty.call(message, "event"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.event);
            if (message.data != null && Object.hasOwnProperty.call(message, "data"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.data);
            return writer;
        };

        /**
         * Encodes the specified SystemMsg message, length delimited. Does not implicitly {@link canari.SystemMsg.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.SystemMsg
         * @static
         * @param {canari.ISystemMsg} message SystemMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        SystemMsg.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a SystemMsg message from the specified reader or buffer.
         * @function decode
         * @memberof canari.SystemMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.SystemMsg} SystemMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        SystemMsg.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.canari.SystemMsg();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.event = reader.string();
                        break;
                    }
                case 2: {
                        message.data = reader.string();
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a SystemMsg message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.SystemMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.SystemMsg} SystemMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        SystemMsg.decodeDelimited = function decodeDelimited(reader) {
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
        SystemMsg.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.event != null && message.hasOwnProperty("event"))
                if (!$util.isString(message.event))
                    return "event: string expected";
            if (message.data != null && message.hasOwnProperty("data"))
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
        SystemMsg.fromObject = function fromObject(object) {
            if (object instanceof $root.canari.SystemMsg)
                return object;
            let message = new $root.canari.SystemMsg();
            if (object.event != null)
                message.event = String(object.event);
            if (object.data != null)
                message.data = String(object.data);
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
        SystemMsg.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.defaults) {
                object.event = "";
                object.data = "";
            }
            if (message.event != null && message.hasOwnProperty("event"))
                object.event = message.event;
            if (message.data != null && message.hasOwnProperty("data"))
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
        SystemMsg.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for SystemMsg
         * @function getTypeUrl
         * @memberof canari.SystemMsg
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        SystemMsg.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/canari.SystemMsg";
        };

        return SystemMsg;
    })();

    return canari;
})();

export { $root as default };
