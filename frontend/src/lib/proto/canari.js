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
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
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
        WsEnvelope.encode = function encode(message, writer, q) {
            if (!writer)
                writer = $Writer.create();
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.mls != null && Object.hasOwnProperty.call(message, "mls"))
                $root.canari.MlsFrame.encode(message.mls, writer.uint32(/* id 1, wireType 2 =*/10).fork(), q + 1).ldelim();
            if (message.welcome != null && Object.hasOwnProperty.call(message, "welcome"))
                $root.canari.WelcomeFrame.encode(message.welcome, writer.uint32(/* id 2, wireType 2 =*/18).fork(), q + 1).ldelim();
            if (message.read != null && Object.hasOwnProperty.call(message, "read"))
                $root.canari.ReadAck.encode(message.read, writer.uint32(/* id 3, wireType 2 =*/26).fork(), q + 1).ldelim();
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
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
        WsEnvelope.decode = function decode(reader, length, z, q, g) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (q === undefined)
                q = 0;
            if (q > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            let end = length === undefined ? reader.len : reader.pos + length, message = g || new C();
            while (reader.pos < end) {
                let s = reader.pos;
                let tag = reader.tag();
                if (tag === z) {
                    z = undefined;
                    break;
                }
                let u = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (u !== 2)
                            break;
                        message.mls = $root.canari.MlsFrame.decode(reader, reader.uint32(), undefined, q + 1, message.mls);
                        message.body = "mls";
                        continue;
                    }
                case 2: {
                        if (u !== 2)
                            break;
                        message.welcome = $root.canari.WelcomeFrame.decode(reader, reader.uint32(), undefined, q + 1, message.welcome);
                        message.body = "welcome";
                        continue;
                    }
                case 3: {
                        if (u !== 2)
                            break;
                        message.read = $root.canari.ReadAck.decode(reader, reader.uint32(), undefined, q + 1, message.read);
                        message.body = "read";
                        continue;
                    }
                }
                reader.skipType(u, q, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(s, reader.pos));
                }
            }
            if (z !== undefined)
                throw Error("missing end group");
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
        WsEnvelope.verify = function verify(message, q) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                return "max depth exceeded";
            let properties = {};
            if (message.mls != null && Object.hasOwnProperty.call(message, "mls")) {
                properties.body = 1;
                {
                    let error = $root.canari.MlsFrame.verify(message.mls, q + 1);
                    if (error)
                        return "mls." + error;
                }
            }
            if (message.welcome != null && Object.hasOwnProperty.call(message, "welcome")) {
                if (properties.body === 1)
                    return "body: multiple values";
                properties.body = 1;
                {
                    let error = $root.canari.WelcomeFrame.verify(message.welcome, q + 1);
                    if (error)
                        return "welcome." + error;
                }
            }
            if (message.read != null && Object.hasOwnProperty.call(message, "read")) {
                if (properties.body === 1)
                    return "body: multiple values";
                properties.body = 1;
                {
                    let error = $root.canari.ReadAck.verify(message.read, q + 1);
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
        WsEnvelope.fromObject = function fromObject(object, q) {
            if (object instanceof C)
                return object;
            if (!$util.isObject(object))
                throw TypeError(".canari.WsEnvelope: object expected");
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            let message = new C();
            if (object.mls != null) {
                if (!$util.isObject(object.mls))
                    throw TypeError(".canari.WsEnvelope.mls: object expected");
                message.mls = $root.canari.MlsFrame.fromObject(object.mls, q + 1);
            }
            if (object.welcome != null) {
                if (!$util.isObject(object.welcome))
                    throw TypeError(".canari.WsEnvelope.welcome: object expected");
                message.welcome = $root.canari.WelcomeFrame.fromObject(object.welcome, q + 1);
            }
            if (object.read != null) {
                if (!$util.isObject(object.read))
                    throw TypeError(".canari.WsEnvelope.read: object expected");
                message.read = $root.canari.ReadAck.fromObject(object.read, q + 1);
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
        WsEnvelope.toObject = function toObject(message, options, q) {
            if (!options)
                options = {};
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            let object = {};
            if (message.mls != null && Object.hasOwnProperty.call(message, "mls")) {
                object.mls = $root.canari.MlsFrame.toObject(message.mls, options, q + 1);
                if (options.oneofs)
                    object.body = "mls";
            }
            if (message.welcome != null && Object.hasOwnProperty.call(message, "welcome")) {
                object.welcome = $root.canari.WelcomeFrame.toObject(message.welcome, options, q + 1);
                if (options.oneofs)
                    object.body = "welcome";
            }
            if (message.read != null && Object.hasOwnProperty.call(message, "read")) {
                object.read = $root.canari.ReadAck.toObject(message.read, options, q + 1);
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
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
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
        Recipient.encode = function encode(message, writer, q) {
            if (!writer)
                writer = $Writer.create();
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.userId != null && Object.hasOwnProperty.call(message, "userId"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.userId);
            if (message.deviceId != null && Object.hasOwnProperty.call(message, "deviceId"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.deviceId);
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
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
        Recipient.decode = function decode(reader, length, z, q, g) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (q === undefined)
                q = 0;
            if (q > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            let end = length === undefined ? reader.len : reader.pos + length, message = g || new C(), v;
            while (reader.pos < end) {
                let s = reader.pos;
                let tag = reader.tag();
                if (tag === z) {
                    z = undefined;
                    break;
                }
                let u = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (u !== 2)
                            break;
                        if ((v = reader.stringVerify()).length)
                            message.userId = v;
                        else
                            delete message.userId;
                        continue;
                    }
                case 2: {
                        if (u !== 2)
                            break;
                        if ((v = reader.stringVerify()).length)
                            message.deviceId = v;
                        else
                            delete message.deviceId;
                        continue;
                    }
                }
                reader.skipType(u, q, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(s, reader.pos));
                }
            }
            if (z !== undefined)
                throw Error("missing end group");
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
        Recipient.verify = function verify(message, q) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                return "max depth exceeded";
            if (message.userId != null && Object.hasOwnProperty.call(message, "userId"))
                if (!$util.isString(message.userId))
                    return "userId: string expected";
            if (message.deviceId != null && Object.hasOwnProperty.call(message, "deviceId"))
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
        Recipient.fromObject = function fromObject(object, q) {
            if (object instanceof C)
                return object;
            if (!$util.isObject(object))
                throw TypeError(".canari.Recipient: object expected");
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            let message = new C();
            if (object.userId != null)
                if (typeof object.userId !== "string" || object.userId.length)
                    message.userId = String(object.userId);
            if (object.deviceId != null)
                if (typeof object.deviceId !== "string" || object.deviceId.length)
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
        Recipient.toObject = function toObject(message, options, q) {
            if (!options)
                options = {};
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            let object = {};
            if (options.defaults) {
                object.userId = "";
                object.deviceId = "";
            }
            if (message.userId != null && Object.hasOwnProperty.call(message, "userId"))
                object.userId = message.userId;
            if (message.deviceId != null && Object.hasOwnProperty.call(message, "deviceId"))
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
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
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
        MlsFrame.encode = function encode(message, writer, q) {
            if (!writer)
                writer = $Writer.create();
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.ciphertext != null && Object.hasOwnProperty.call(message, "ciphertext"))
                writer.uint32(/* id 1, wireType 2 =*/10).bytes(message.ciphertext);
            if (message.groupId != null && Object.hasOwnProperty.call(message, "groupId"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.groupId);
            if (message.recipients != null && message.recipients.length)
                for (let i = 0; i < message.recipients.length; ++i)
                    $root.canari.Recipient.encode(message.recipients[i], writer.uint32(/* id 3, wireType 2 =*/26).fork(), q + 1).ldelim();
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
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
        MlsFrame.decode = function decode(reader, length, z, q, g) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (q === undefined)
                q = 0;
            if (q > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            let end = length === undefined ? reader.len : reader.pos + length, message = g || new C(), v;
            while (reader.pos < end) {
                let s = reader.pos;
                let tag = reader.tag();
                if (tag === z) {
                    z = undefined;
                    break;
                }
                let u = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (u !== 2)
                            break;
                        if ((v = reader.bytes()).length)
                            message.ciphertext = v;
                        else
                            delete message.ciphertext;
                        continue;
                    }
                case 2: {
                        if (u !== 2)
                            break;
                        if ((v = reader.stringVerify()).length)
                            message.groupId = v;
                        else
                            delete message.groupId;
                        continue;
                    }
                case 3: {
                        if (u !== 2)
                            break;
                        if (!(message.recipients && message.recipients.length))
                            message.recipients = [];
                        message.recipients.push($root.canari.Recipient.decode(reader, reader.uint32(), undefined, q + 1));
                        continue;
                    }
                }
                reader.skipType(u, q, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(s, reader.pos));
                }
            }
            if (z !== undefined)
                throw Error("missing end group");
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
        MlsFrame.verify = function verify(message, q) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                return "max depth exceeded";
            if (message.ciphertext != null && Object.hasOwnProperty.call(message, "ciphertext"))
                if (!(message.ciphertext && typeof message.ciphertext.length === "number" || $util.isString(message.ciphertext)))
                    return "ciphertext: buffer expected";
            if (message.groupId != null && Object.hasOwnProperty.call(message, "groupId"))
                if (!$util.isString(message.groupId))
                    return "groupId: string expected";
            if (message.recipients != null && Object.hasOwnProperty.call(message, "recipients")) {
                if (!Array.isArray(message.recipients))
                    return "recipients: array expected";
                for (let i = 0; i < message.recipients.length; ++i) {
                    let error = $root.canari.Recipient.verify(message.recipients[i], q + 1);
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
        MlsFrame.fromObject = function fromObject(object, q) {
            if (object instanceof C)
                return object;
            if (!$util.isObject(object))
                throw TypeError(".canari.MlsFrame: object expected");
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            let message = new C();
            if (object.ciphertext != null)
                if (object.ciphertext.length)
                    if (typeof object.ciphertext === "string")
                        $util.base64.decode(object.ciphertext, message.ciphertext = $util.newBuffer($util.base64.length(object.ciphertext)), 0);
                    else if (object.ciphertext.length >= 0)
                        message.ciphertext = object.ciphertext;
            if (object.groupId != null)
                if (typeof object.groupId !== "string" || object.groupId.length)
                    message.groupId = String(object.groupId);
            if (object.recipients) {
                if (!Array.isArray(object.recipients))
                    throw TypeError(".canari.MlsFrame.recipients: array expected");
                message.recipients = Array(object.recipients.length);
                for (let i = 0; i < object.recipients.length; ++i) {
                    if (!$util.isObject(object.recipients[i]))
                        throw TypeError(".canari.MlsFrame.recipients: object expected");
                    message.recipients[i] = $root.canari.Recipient.fromObject(object.recipients[i], q + 1);
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
        MlsFrame.toObject = function toObject(message, options, q) {
            if (!options)
                options = {};
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
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
            if (message.ciphertext != null && Object.hasOwnProperty.call(message, "ciphertext"))
                object.ciphertext = options.bytes === String ? $util.base64.encode(message.ciphertext, 0, message.ciphertext.length) : options.bytes === Array ? Array.prototype.slice.call(message.ciphertext) : message.ciphertext;
            if (message.groupId != null && Object.hasOwnProperty.call(message, "groupId"))
                object.groupId = message.groupId;
            if (message.recipients && message.recipients.length) {
                object.recipients = Array(message.recipients.length);
                for (let j = 0; j < message.recipients.length; ++j)
                    object.recipients[j] = $root.canari.Recipient.toObject(message.recipients[j], options, q + 1);
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
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
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
        WelcomeFrame.encode = function encode(message, writer, q) {
            if (!writer)
                writer = $Writer.create();
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.ciphertext != null && Object.hasOwnProperty.call(message, "ciphertext"))
                writer.uint32(/* id 1, wireType 2 =*/10).bytes(message.ciphertext);
            if (message.groupId != null && Object.hasOwnProperty.call(message, "groupId"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.groupId);
            if (message.recipients != null && message.recipients.length)
                for (let i = 0; i < message.recipients.length; ++i)
                    $root.canari.Recipient.encode(message.recipients[i], writer.uint32(/* id 3, wireType 2 =*/26).fork(), q + 1).ldelim();
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
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
        WelcomeFrame.decode = function decode(reader, length, z, q, g) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (q === undefined)
                q = 0;
            if (q > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            let end = length === undefined ? reader.len : reader.pos + length, message = g || new C(), v;
            while (reader.pos < end) {
                let s = reader.pos;
                let tag = reader.tag();
                if (tag === z) {
                    z = undefined;
                    break;
                }
                let u = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (u !== 2)
                            break;
                        if ((v = reader.bytes()).length)
                            message.ciphertext = v;
                        else
                            delete message.ciphertext;
                        continue;
                    }
                case 2: {
                        if (u !== 2)
                            break;
                        if ((v = reader.stringVerify()).length)
                            message.groupId = v;
                        else
                            delete message.groupId;
                        continue;
                    }
                case 3: {
                        if (u !== 2)
                            break;
                        if (!(message.recipients && message.recipients.length))
                            message.recipients = [];
                        message.recipients.push($root.canari.Recipient.decode(reader, reader.uint32(), undefined, q + 1));
                        continue;
                    }
                }
                reader.skipType(u, q, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(s, reader.pos));
                }
            }
            if (z !== undefined)
                throw Error("missing end group");
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
        WelcomeFrame.verify = function verify(message, q) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                return "max depth exceeded";
            if (message.ciphertext != null && Object.hasOwnProperty.call(message, "ciphertext"))
                if (!(message.ciphertext && typeof message.ciphertext.length === "number" || $util.isString(message.ciphertext)))
                    return "ciphertext: buffer expected";
            if (message.groupId != null && Object.hasOwnProperty.call(message, "groupId"))
                if (!$util.isString(message.groupId))
                    return "groupId: string expected";
            if (message.recipients != null && Object.hasOwnProperty.call(message, "recipients")) {
                if (!Array.isArray(message.recipients))
                    return "recipients: array expected";
                for (let i = 0; i < message.recipients.length; ++i) {
                    let error = $root.canari.Recipient.verify(message.recipients[i], q + 1);
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
        WelcomeFrame.fromObject = function fromObject(object, q) {
            if (object instanceof C)
                return object;
            if (!$util.isObject(object))
                throw TypeError(".canari.WelcomeFrame: object expected");
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            let message = new C();
            if (object.ciphertext != null)
                if (object.ciphertext.length)
                    if (typeof object.ciphertext === "string")
                        $util.base64.decode(object.ciphertext, message.ciphertext = $util.newBuffer($util.base64.length(object.ciphertext)), 0);
                    else if (object.ciphertext.length >= 0)
                        message.ciphertext = object.ciphertext;
            if (object.groupId != null)
                if (typeof object.groupId !== "string" || object.groupId.length)
                    message.groupId = String(object.groupId);
            if (object.recipients) {
                if (!Array.isArray(object.recipients))
                    throw TypeError(".canari.WelcomeFrame.recipients: array expected");
                message.recipients = Array(object.recipients.length);
                for (let i = 0; i < object.recipients.length; ++i) {
                    if (!$util.isObject(object.recipients[i]))
                        throw TypeError(".canari.WelcomeFrame.recipients: object expected");
                    message.recipients[i] = $root.canari.Recipient.fromObject(object.recipients[i], q + 1);
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
        WelcomeFrame.toObject = function toObject(message, options, q) {
            if (!options)
                options = {};
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
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
            if (message.ciphertext != null && Object.hasOwnProperty.call(message, "ciphertext"))
                object.ciphertext = options.bytes === String ? $util.base64.encode(message.ciphertext, 0, message.ciphertext.length) : options.bytes === Array ? Array.prototype.slice.call(message.ciphertext) : message.ciphertext;
            if (message.groupId != null && Object.hasOwnProperty.call(message, "groupId"))
                object.groupId = message.groupId;
            if (message.recipients && message.recipients.length) {
                object.recipients = Array(message.recipients.length);
                for (let j = 0; j < message.recipients.length; ++j)
                    object.recipients[j] = $root.canari.Recipient.toObject(message.recipients[j], options, q + 1);
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
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
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
        ReadAck.encode = function encode(message, writer, q) {
            if (!writer)
                writer = $Writer.create();
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.messageId != null && Object.hasOwnProperty.call(message, "messageId"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.messageId);
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
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
        ReadAck.decode = function decode(reader, length, z, q, g) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (q === undefined)
                q = 0;
            if (q > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            let end = length === undefined ? reader.len : reader.pos + length, message = g || new C(), v;
            while (reader.pos < end) {
                let s = reader.pos;
                let tag = reader.tag();
                if (tag === z) {
                    z = undefined;
                    break;
                }
                let u = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (u !== 2)
                            break;
                        if ((v = reader.stringVerify()).length)
                            message.messageId = v;
                        else
                            delete message.messageId;
                        continue;
                    }
                }
                reader.skipType(u, q, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(s, reader.pos));
                }
            }
            if (z !== undefined)
                throw Error("missing end group");
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
        ReadAck.verify = function verify(message, q) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                return "max depth exceeded";
            if (message.messageId != null && Object.hasOwnProperty.call(message, "messageId"))
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
        ReadAck.fromObject = function fromObject(object, q) {
            if (object instanceof C)
                return object;
            if (!$util.isObject(object))
                throw TypeError(".canari.ReadAck: object expected");
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            let message = new C();
            if (object.messageId != null)
                if (typeof object.messageId !== "string" || object.messageId.length)
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
        ReadAck.toObject = function toObject(message, options, q) {
            if (!options)
                options = {};
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            let object = {};
            if (options.defaults)
                object.messageId = "";
            if (message.messageId != null && Object.hasOwnProperty.call(message, "messageId"))
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
         * @property {boolean|null} [isCommit] InboundMsg isCommit
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
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
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
        InboundMsg.encode = function encode(message, writer, q) {
            if (!writer)
                writer = $Writer.create();
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
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
            if (message.isCommit != null && Object.hasOwnProperty.call(message, "isCommit"))
                writer.uint32(/* id 6, wireType 0 =*/48).bool(message.isCommit);
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
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
        InboundMsg.decode = function decode(reader, length, z, q, g) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (q === undefined)
                q = 0;
            if (q > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            let end = length === undefined ? reader.len : reader.pos + length, message = g || new C(), v;
            while (reader.pos < end) {
                let s = reader.pos;
                let tag = reader.tag();
                if (tag === z) {
                    z = undefined;
                    break;
                }
                let u = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (u !== 2)
                            break;
                        if ((v = reader.bytes()).length)
                            message.ciphertext = v;
                        else
                            delete message.ciphertext;
                        continue;
                    }
                case 2: {
                        if (u !== 2)
                            break;
                        if ((v = reader.stringVerify()).length)
                            message.senderId = v;
                        else
                            delete message.senderId;
                        continue;
                    }
                case 3: {
                        if (u !== 2)
                            break;
                        if ((v = reader.stringVerify()).length)
                            message.senderDeviceId = v;
                        else
                            delete message.senderDeviceId;
                        continue;
                    }
                case 4: {
                        if (u !== 2)
                            break;
                        if ((v = reader.stringVerify()).length)
                            message.groupId = v;
                        else
                            delete message.groupId;
                        continue;
                    }
                case 5: {
                        if (u !== 0)
                            break;
                        if (v = reader.bool())
                            message.isWelcome = v;
                        else
                            delete message.isWelcome;
                        continue;
                    }
                case 6: {
                        if (u !== 0)
                            break;
                        if (v = reader.bool())
                            message.isCommit = v;
                        else
                            delete message.isCommit;
                        continue;
                    }
                }
                reader.skipType(u, q, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(s, reader.pos));
                }
            }
            if (z !== undefined)
                throw Error("missing end group");
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
        InboundMsg.verify = function verify(message, q) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                return "max depth exceeded";
            if (message.ciphertext != null && Object.hasOwnProperty.call(message, "ciphertext"))
                if (!(message.ciphertext && typeof message.ciphertext.length === "number" || $util.isString(message.ciphertext)))
                    return "ciphertext: buffer expected";
            if (message.senderId != null && Object.hasOwnProperty.call(message, "senderId"))
                if (!$util.isString(message.senderId))
                    return "senderId: string expected";
            if (message.senderDeviceId != null && Object.hasOwnProperty.call(message, "senderDeviceId"))
                if (!$util.isString(message.senderDeviceId))
                    return "senderDeviceId: string expected";
            if (message.groupId != null && Object.hasOwnProperty.call(message, "groupId"))
                if (!$util.isString(message.groupId))
                    return "groupId: string expected";
            if (message.isWelcome != null && Object.hasOwnProperty.call(message, "isWelcome"))
                if (typeof message.isWelcome !== "boolean")
                    return "isWelcome: boolean expected";
            if (message.isCommit != null && Object.hasOwnProperty.call(message, "isCommit"))
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
        InboundMsg.fromObject = function fromObject(object, q) {
            if (object instanceof C)
                return object;
            if (!$util.isObject(object))
                throw TypeError(".canari.InboundMsg: object expected");
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            let message = new C();
            if (object.ciphertext != null)
                if (object.ciphertext.length)
                    if (typeof object.ciphertext === "string")
                        $util.base64.decode(object.ciphertext, message.ciphertext = $util.newBuffer($util.base64.length(object.ciphertext)), 0);
                    else if (object.ciphertext.length >= 0)
                        message.ciphertext = object.ciphertext;
            if (object.senderId != null)
                if (typeof object.senderId !== "string" || object.senderId.length)
                    message.senderId = String(object.senderId);
            if (object.senderDeviceId != null)
                if (typeof object.senderDeviceId !== "string" || object.senderDeviceId.length)
                    message.senderDeviceId = String(object.senderDeviceId);
            if (object.groupId != null)
                if (typeof object.groupId !== "string" || object.groupId.length)
                    message.groupId = String(object.groupId);
            if (object.isWelcome != null)
                if (object.isWelcome)
                    message.isWelcome = Boolean(object.isWelcome);
            if (object.isCommit != null)
                if (object.isCommit)
                    message.isCommit = Boolean(object.isCommit);
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
        InboundMsg.toObject = function toObject(message, options, q) {
            if (!options)
                options = {};
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
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
                object.isCommit = false;
            }
            if (message.ciphertext != null && Object.hasOwnProperty.call(message, "ciphertext"))
                object.ciphertext = options.bytes === String ? $util.base64.encode(message.ciphertext, 0, message.ciphertext.length) : options.bytes === Array ? Array.prototype.slice.call(message.ciphertext) : message.ciphertext;
            if (message.senderId != null && Object.hasOwnProperty.call(message, "senderId"))
                object.senderId = message.senderId;
            if (message.senderDeviceId != null && Object.hasOwnProperty.call(message, "senderDeviceId"))
                object.senderDeviceId = message.senderDeviceId;
            if (message.groupId != null && Object.hasOwnProperty.call(message, "groupId"))
                object.groupId = message.groupId;
            if (message.isWelcome != null && Object.hasOwnProperty.call(message, "isWelcome"))
                object.isWelcome = message.isWelcome;
            if (message.isCommit != null && Object.hasOwnProperty.call(message, "isCommit"))
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
         * @property {number|null} [sentAt] AppMessage sentAt
         * @property {canari.ITextMsg|null} [text] AppMessage text
         * @property {canari.IReplyMsg|null} [reply] AppMessage reply
         * @property {canari.IReactionMsg|null} [reaction] AppMessage reaction
         * @property {canari.IMediaMsg|null} [media] AppMessage media
         * @property {canari.ISystemMsg|null} [system] AppMessage system
         * @property {canari.ICallMsg|null} [call] AppMessage call
         * @property {canari.IPollMsg|null} [poll] AppMessage poll
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
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
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
         * AppMessage sentAt.
         * @member {number} sentAt
         * @memberof canari.AppMessage
         * @instance
         */
        AppMessage.prototype.sentAt = $util.Long ? $util.Long.fromBits(0,0,false) : 0;

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

        /**
         * AppMessage poll.
         * @member {canari.IPollMsg|null|undefined} poll
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
        Object.defineProperty(AppMessage.prototype, "kind", {
            get: $util.oneOfGetter($oneOfFields = ["text", "reply", "reaction", "media", "system", "call", "poll"]),
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
        AppMessage.encode = function encode(message, writer, q) {
            if (!writer)
                writer = $Writer.create();
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.text != null && Object.hasOwnProperty.call(message, "text"))
                $root.canari.TextMsg.encode(message.text, writer.uint32(/* id 1, wireType 2 =*/10).fork(), q + 1).ldelim();
            if (message.reply != null && Object.hasOwnProperty.call(message, "reply"))
                $root.canari.ReplyMsg.encode(message.reply, writer.uint32(/* id 2, wireType 2 =*/18).fork(), q + 1).ldelim();
            if (message.reaction != null && Object.hasOwnProperty.call(message, "reaction"))
                $root.canari.ReactionMsg.encode(message.reaction, writer.uint32(/* id 3, wireType 2 =*/26).fork(), q + 1).ldelim();
            if (message.media != null && Object.hasOwnProperty.call(message, "media"))
                $root.canari.MediaMsg.encode(message.media, writer.uint32(/* id 4, wireType 2 =*/34).fork(), q + 1).ldelim();
            if (message.system != null && Object.hasOwnProperty.call(message, "system"))
                $root.canari.SystemMsg.encode(message.system, writer.uint32(/* id 5, wireType 2 =*/42).fork(), q + 1).ldelim();
            if (message.messageId != null && Object.hasOwnProperty.call(message, "messageId"))
                writer.uint32(/* id 6, wireType 2 =*/50).string(message.messageId);
            if (message.call != null && Object.hasOwnProperty.call(message, "call"))
                $root.canari.CallMsg.encode(message.call, writer.uint32(/* id 7, wireType 2 =*/58).fork(), q + 1).ldelim();
            if (message.sentAt != null && Object.hasOwnProperty.call(message, "sentAt"))
                writer.uint32(/* id 8, wireType 0 =*/64).int64(message.sentAt);
            if (message.poll != null && Object.hasOwnProperty.call(message, "poll"))
                $root.canari.PollMsg.encode(message.poll, writer.uint32(/* id 9, wireType 2 =*/74).fork(), q + 1).ldelim();
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
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
        AppMessage.decode = function decode(reader, length, z, q, g) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (q === undefined)
                q = 0;
            if (q > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            let end = length === undefined ? reader.len : reader.pos + length, message = g || new C(), v;
            while (reader.pos < end) {
                let s = reader.pos;
                let tag = reader.tag();
                if (tag === z) {
                    z = undefined;
                    break;
                }
                let u = tag & 7;
                switch (tag >>>= 3) {
                case 6: {
                        if (u !== 2)
                            break;
                        if ((v = reader.stringVerify()).length)
                            message.messageId = v;
                        else
                            delete message.messageId;
                        continue;
                    }
                case 8: {
                        if (u !== 0)
                            break;
                        if (typeof (v = reader.int64()) === "object" ? v.low || v.high : v !== 0)
                            message.sentAt = v;
                        else
                            delete message.sentAt;
                        continue;
                    }
                case 1: {
                        if (u !== 2)
                            break;
                        message.text = $root.canari.TextMsg.decode(reader, reader.uint32(), undefined, q + 1, message.text);
                        message.kind = "text";
                        continue;
                    }
                case 2: {
                        if (u !== 2)
                            break;
                        message.reply = $root.canari.ReplyMsg.decode(reader, reader.uint32(), undefined, q + 1, message.reply);
                        message.kind = "reply";
                        continue;
                    }
                case 3: {
                        if (u !== 2)
                            break;
                        message.reaction = $root.canari.ReactionMsg.decode(reader, reader.uint32(), undefined, q + 1, message.reaction);
                        message.kind = "reaction";
                        continue;
                    }
                case 4: {
                        if (u !== 2)
                            break;
                        message.media = $root.canari.MediaMsg.decode(reader, reader.uint32(), undefined, q + 1, message.media);
                        message.kind = "media";
                        continue;
                    }
                case 5: {
                        if (u !== 2)
                            break;
                        message.system = $root.canari.SystemMsg.decode(reader, reader.uint32(), undefined, q + 1, message.system);
                        message.kind = "system";
                        continue;
                    }
                case 7: {
                        if (u !== 2)
                            break;
                        message.call = $root.canari.CallMsg.decode(reader, reader.uint32(), undefined, q + 1, message.call);
                        message.kind = "call";
                        continue;
                    }
                case 9: {
                        if (u !== 2)
                            break;
                        message.poll = $root.canari.PollMsg.decode(reader, reader.uint32(), undefined, q + 1, message.poll);
                        message.kind = "poll";
                        continue;
                    }
                }
                reader.skipType(u, q, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(s, reader.pos));
                }
            }
            if (z !== undefined)
                throw Error("missing end group");
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
        AppMessage.verify = function verify(message, q) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                return "max depth exceeded";
            let properties = {};
            if (message.messageId != null && Object.hasOwnProperty.call(message, "messageId"))
                if (!$util.isString(message.messageId))
                    return "messageId: string expected";
            if (message.sentAt != null && Object.hasOwnProperty.call(message, "sentAt"))
                if (!$util.isInteger(message.sentAt) && !(message.sentAt && $util.isInteger(message.sentAt.low) && $util.isInteger(message.sentAt.high)))
                    return "sentAt: integer|Long expected";
            if (message.text != null && Object.hasOwnProperty.call(message, "text")) {
                properties.kind = 1;
                {
                    let error = $root.canari.TextMsg.verify(message.text, q + 1);
                    if (error)
                        return "text." + error;
                }
            }
            if (message.reply != null && Object.hasOwnProperty.call(message, "reply")) {
                if (properties.kind === 1)
                    return "kind: multiple values";
                properties.kind = 1;
                {
                    let error = $root.canari.ReplyMsg.verify(message.reply, q + 1);
                    if (error)
                        return "reply." + error;
                }
            }
            if (message.reaction != null && Object.hasOwnProperty.call(message, "reaction")) {
                if (properties.kind === 1)
                    return "kind: multiple values";
                properties.kind = 1;
                {
                    let error = $root.canari.ReactionMsg.verify(message.reaction, q + 1);
                    if (error)
                        return "reaction." + error;
                }
            }
            if (message.media != null && Object.hasOwnProperty.call(message, "media")) {
                if (properties.kind === 1)
                    return "kind: multiple values";
                properties.kind = 1;
                {
                    let error = $root.canari.MediaMsg.verify(message.media, q + 1);
                    if (error)
                        return "media." + error;
                }
            }
            if (message.system != null && Object.hasOwnProperty.call(message, "system")) {
                if (properties.kind === 1)
                    return "kind: multiple values";
                properties.kind = 1;
                {
                    let error = $root.canari.SystemMsg.verify(message.system, q + 1);
                    if (error)
                        return "system." + error;
                }
            }
            if (message.call != null && Object.hasOwnProperty.call(message, "call")) {
                if (properties.kind === 1)
                    return "kind: multiple values";
                properties.kind = 1;
                {
                    let error = $root.canari.CallMsg.verify(message.call, q + 1);
                    if (error)
                        return "call." + error;
                }
            }
            if (message.poll != null && Object.hasOwnProperty.call(message, "poll")) {
                if (properties.kind === 1)
                    return "kind: multiple values";
                properties.kind = 1;
                {
                    let error = $root.canari.PollMsg.verify(message.poll, q + 1);
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
        AppMessage.fromObject = function fromObject(object, q) {
            if (object instanceof C)
                return object;
            if (!$util.isObject(object))
                throw TypeError(".canari.AppMessage: object expected");
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            let message = new C();
            if (object.messageId != null)
                if (typeof object.messageId !== "string" || object.messageId.length)
                    message.messageId = String(object.messageId);
            if (object.sentAt != null)
                if (typeof object.sentAt === "object" ? object.sentAt.low || object.sentAt.high : Number(object.sentAt) !== 0)
                    if ($util.Long)
                        message.sentAt = $util.Long.fromValue(object.sentAt, false);
                    else if (typeof object.sentAt === "string")
                        message.sentAt = parseInt(object.sentAt, 10);
                    else if (typeof object.sentAt === "number")
                        message.sentAt = object.sentAt;
                    else if (typeof object.sentAt === "object")
                        message.sentAt = new $util.LongBits(object.sentAt.low >>> 0, object.sentAt.high >>> 0).toNumber();
            if (object.text != null) {
                if (!$util.isObject(object.text))
                    throw TypeError(".canari.AppMessage.text: object expected");
                message.text = $root.canari.TextMsg.fromObject(object.text, q + 1);
            }
            if (object.reply != null) {
                if (!$util.isObject(object.reply))
                    throw TypeError(".canari.AppMessage.reply: object expected");
                message.reply = $root.canari.ReplyMsg.fromObject(object.reply, q + 1);
            }
            if (object.reaction != null) {
                if (!$util.isObject(object.reaction))
                    throw TypeError(".canari.AppMessage.reaction: object expected");
                message.reaction = $root.canari.ReactionMsg.fromObject(object.reaction, q + 1);
            }
            if (object.media != null) {
                if (!$util.isObject(object.media))
                    throw TypeError(".canari.AppMessage.media: object expected");
                message.media = $root.canari.MediaMsg.fromObject(object.media, q + 1);
            }
            if (object.system != null) {
                if (!$util.isObject(object.system))
                    throw TypeError(".canari.AppMessage.system: object expected");
                message.system = $root.canari.SystemMsg.fromObject(object.system, q + 1);
            }
            if (object.call != null) {
                if (!$util.isObject(object.call))
                    throw TypeError(".canari.AppMessage.call: object expected");
                message.call = $root.canari.CallMsg.fromObject(object.call, q + 1);
            }
            if (object.poll != null) {
                if (!$util.isObject(object.poll))
                    throw TypeError(".canari.AppMessage.poll: object expected");
                message.poll = $root.canari.PollMsg.fromObject(object.poll, q + 1);
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
        AppMessage.toObject = function toObject(message, options, q) {
            if (!options)
                options = {};
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            let object = {};
            if (options.defaults) {
                object.messageId = "";
                if ($util.Long) {
                    let long = new $util.Long(0, 0, false);
                    object.sentAt = options.longs === String ? long.toString() : options.longs === Number ? long.toNumber() : typeof BigInt !== "undefined" && options.longs === BigInt ? long.toBigInt() : long;
                } else
                    object.sentAt = options.longs === String ? "0" : typeof BigInt !== "undefined" && options.longs === BigInt ? BigInt("0") : 0;
            }
            if (message.text != null && Object.hasOwnProperty.call(message, "text")) {
                object.text = $root.canari.TextMsg.toObject(message.text, options, q + 1);
                if (options.oneofs)
                    object.kind = "text";
            }
            if (message.reply != null && Object.hasOwnProperty.call(message, "reply")) {
                object.reply = $root.canari.ReplyMsg.toObject(message.reply, options, q + 1);
                if (options.oneofs)
                    object.kind = "reply";
            }
            if (message.reaction != null && Object.hasOwnProperty.call(message, "reaction")) {
                object.reaction = $root.canari.ReactionMsg.toObject(message.reaction, options, q + 1);
                if (options.oneofs)
                    object.kind = "reaction";
            }
            if (message.media != null && Object.hasOwnProperty.call(message, "media")) {
                object.media = $root.canari.MediaMsg.toObject(message.media, options, q + 1);
                if (options.oneofs)
                    object.kind = "media";
            }
            if (message.system != null && Object.hasOwnProperty.call(message, "system")) {
                object.system = $root.canari.SystemMsg.toObject(message.system, options, q + 1);
                if (options.oneofs)
                    object.kind = "system";
            }
            if (message.messageId != null && Object.hasOwnProperty.call(message, "messageId"))
                object.messageId = message.messageId;
            if (message.call != null && Object.hasOwnProperty.call(message, "call")) {
                object.call = $root.canari.CallMsg.toObject(message.call, options, q + 1);
                if (options.oneofs)
                    object.kind = "call";
            }
            if (message.sentAt != null && Object.hasOwnProperty.call(message, "sentAt"))
                if (typeof BigInt !== "undefined" && options.longs === BigInt)
                    object.sentAt = typeof message.sentAt === "number" ? BigInt(message.sentAt) : $util.Long.fromBits(message.sentAt.low >>> 0, message.sentAt.high >>> 0, false).toBigInt();
                else if (typeof message.sentAt === "number")
                    object.sentAt = options.longs === String ? String(message.sentAt) : message.sentAt;
                else
                    object.sentAt = options.longs === String ? $util.Long.prototype.toString.call(message.sentAt) : options.longs === Number ? new $util.LongBits(message.sentAt.low >>> 0, message.sentAt.high >>> 0).toNumber() : message.sentAt;
            if (message.poll != null && Object.hasOwnProperty.call(message, "poll")) {
                object.poll = $root.canari.PollMsg.toObject(message.poll, options, q + 1);
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
         * @property {boolean|null} [hasVideo] CallMsg hasVideo
         * @property {string|null} [deviceId] CallMsg deviceId
         * @property {string|null} [offerSdp] CallMsg offerSdp
         * @property {string|null} [answerSdp] CallMsg answerSdp
         * @property {string|null} [iceCandidate] CallMsg iceCandidate
         * @property {boolean|null} [hangup] CallMsg hangup
         * @property {boolean|null} [answered] CallMsg answered
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
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
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
        Object.defineProperty(CallMsg.prototype, "payload", {
            get: $util.oneOfGetter($oneOfFields = ["offerSdp", "answerSdp", "iceCandidate", "hangup", "answered"]),
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
        CallMsg.encode = function encode(message, writer, q) {
            if (!writer)
                writer = $Writer.create();
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
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
            if (message.hasVideo != null && Object.hasOwnProperty.call(message, "hasVideo"))
                writer.uint32(/* id 6, wireType 0 =*/48).bool(message.hasVideo);
            if (message.answered != null && Object.hasOwnProperty.call(message, "answered"))
                writer.uint32(/* id 7, wireType 0 =*/56).bool(message.answered);
            if (message.deviceId != null && Object.hasOwnProperty.call(message, "deviceId"))
                writer.uint32(/* id 8, wireType 2 =*/66).string(message.deviceId);
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
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
        CallMsg.decode = function decode(reader, length, z, q, g) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (q === undefined)
                q = 0;
            if (q > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            let end = length === undefined ? reader.len : reader.pos + length, message = g || new C(), v;
            while (reader.pos < end) {
                let s = reader.pos;
                let tag = reader.tag();
                if (tag === z) {
                    z = undefined;
                    break;
                }
                let u = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (u !== 2)
                            break;
                        if ((v = reader.stringVerify()).length)
                            message.callId = v;
                        else
                            delete message.callId;
                        continue;
                    }
                case 6: {
                        if (u !== 0)
                            break;
                        if (v = reader.bool())
                            message.hasVideo = v;
                        else
                            delete message.hasVideo;
                        continue;
                    }
                case 8: {
                        if (u !== 2)
                            break;
                        if ((v = reader.stringVerify()).length)
                            message.deviceId = v;
                        else
                            delete message.deviceId;
                        continue;
                    }
                case 2: {
                        if (u !== 2)
                            break;
                        message.offerSdp = reader.stringVerify();
                        message.payload = "offerSdp";
                        continue;
                    }
                case 3: {
                        if (u !== 2)
                            break;
                        message.answerSdp = reader.stringVerify();
                        message.payload = "answerSdp";
                        continue;
                    }
                case 4: {
                        if (u !== 2)
                            break;
                        message.iceCandidate = reader.stringVerify();
                        message.payload = "iceCandidate";
                        continue;
                    }
                case 5: {
                        if (u !== 0)
                            break;
                        message.hangup = reader.bool();
                        message.payload = "hangup";
                        continue;
                    }
                case 7: {
                        if (u !== 0)
                            break;
                        message.answered = reader.bool();
                        message.payload = "answered";
                        continue;
                    }
                }
                reader.skipType(u, q, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(s, reader.pos));
                }
            }
            if (z !== undefined)
                throw Error("missing end group");
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
        CallMsg.verify = function verify(message, q) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                return "max depth exceeded";
            let properties = {};
            if (message.callId != null && Object.hasOwnProperty.call(message, "callId"))
                if (!$util.isString(message.callId))
                    return "callId: string expected";
            if (message.hasVideo != null && Object.hasOwnProperty.call(message, "hasVideo"))
                if (typeof message.hasVideo !== "boolean")
                    return "hasVideo: boolean expected";
            if (message.deviceId != null && Object.hasOwnProperty.call(message, "deviceId"))
                if (!$util.isString(message.deviceId))
                    return "deviceId: string expected";
            if (message.offerSdp != null && Object.hasOwnProperty.call(message, "offerSdp")) {
                properties.payload = 1;
                if (!$util.isString(message.offerSdp))
                    return "offerSdp: string expected";
            }
            if (message.answerSdp != null && Object.hasOwnProperty.call(message, "answerSdp")) {
                if (properties.payload === 1)
                    return "payload: multiple values";
                properties.payload = 1;
                if (!$util.isString(message.answerSdp))
                    return "answerSdp: string expected";
            }
            if (message.iceCandidate != null && Object.hasOwnProperty.call(message, "iceCandidate")) {
                if (properties.payload === 1)
                    return "payload: multiple values";
                properties.payload = 1;
                if (!$util.isString(message.iceCandidate))
                    return "iceCandidate: string expected";
            }
            if (message.hangup != null && Object.hasOwnProperty.call(message, "hangup")) {
                if (properties.payload === 1)
                    return "payload: multiple values";
                properties.payload = 1;
                if (typeof message.hangup !== "boolean")
                    return "hangup: boolean expected";
            }
            if (message.answered != null && Object.hasOwnProperty.call(message, "answered")) {
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
        CallMsg.fromObject = function fromObject(object, q) {
            if (object instanceof C)
                return object;
            if (!$util.isObject(object))
                throw TypeError(".canari.CallMsg: object expected");
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            let message = new C();
            if (object.callId != null)
                if (typeof object.callId !== "string" || object.callId.length)
                    message.callId = String(object.callId);
            if (object.hasVideo != null)
                if (object.hasVideo)
                    message.hasVideo = Boolean(object.hasVideo);
            if (object.deviceId != null)
                if (typeof object.deviceId !== "string" || object.deviceId.length)
                    message.deviceId = String(object.deviceId);
            if (object.offerSdp != null)
                message.offerSdp = String(object.offerSdp);
            if (object.answerSdp != null)
                message.answerSdp = String(object.answerSdp);
            if (object.iceCandidate != null)
                message.iceCandidate = String(object.iceCandidate);
            if (object.hangup != null)
                message.hangup = Boolean(object.hangup);
            if (object.answered != null)
                message.answered = Boolean(object.answered);
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
        CallMsg.toObject = function toObject(message, options, q) {
            if (!options)
                options = {};
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            let object = {};
            if (options.defaults) {
                object.callId = "";
                object.hasVideo = false;
                object.deviceId = "";
            }
            if (message.callId != null && Object.hasOwnProperty.call(message, "callId"))
                object.callId = message.callId;
            if (message.offerSdp != null && Object.hasOwnProperty.call(message, "offerSdp")) {
                object.offerSdp = message.offerSdp;
                if (options.oneofs)
                    object.payload = "offerSdp";
            }
            if (message.answerSdp != null && Object.hasOwnProperty.call(message, "answerSdp")) {
                object.answerSdp = message.answerSdp;
                if (options.oneofs)
                    object.payload = "answerSdp";
            }
            if (message.iceCandidate != null && Object.hasOwnProperty.call(message, "iceCandidate")) {
                object.iceCandidate = message.iceCandidate;
                if (options.oneofs)
                    object.payload = "iceCandidate";
            }
            if (message.hangup != null && Object.hasOwnProperty.call(message, "hangup")) {
                object.hangup = message.hangup;
                if (options.oneofs)
                    object.payload = "hangup";
            }
            if (message.hasVideo != null && Object.hasOwnProperty.call(message, "hasVideo"))
                object.hasVideo = message.hasVideo;
            if (message.answered != null && Object.hasOwnProperty.call(message, "answered")) {
                object.answered = message.answered;
                if (options.oneofs)
                    object.payload = "answered";
            }
            if (message.deviceId != null && Object.hasOwnProperty.call(message, "deviceId"))
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
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
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
        TextMsg.encode = function encode(message, writer, q) {
            if (!writer)
                writer = $Writer.create();
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.content != null && Object.hasOwnProperty.call(message, "content"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.content);
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
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
        TextMsg.decode = function decode(reader, length, z, q, g) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (q === undefined)
                q = 0;
            if (q > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            let end = length === undefined ? reader.len : reader.pos + length, message = g || new C(), v;
            while (reader.pos < end) {
                let s = reader.pos;
                let tag = reader.tag();
                if (tag === z) {
                    z = undefined;
                    break;
                }
                let u = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (u !== 2)
                            break;
                        if ((v = reader.stringVerify()).length)
                            message.content = v;
                        else
                            delete message.content;
                        continue;
                    }
                }
                reader.skipType(u, q, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(s, reader.pos));
                }
            }
            if (z !== undefined)
                throw Error("missing end group");
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
        TextMsg.verify = function verify(message, q) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                return "max depth exceeded";
            if (message.content != null && Object.hasOwnProperty.call(message, "content"))
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
        TextMsg.fromObject = function fromObject(object, q) {
            if (object instanceof C)
                return object;
            if (!$util.isObject(object))
                throw TypeError(".canari.TextMsg: object expected");
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            let message = new C();
            if (object.content != null)
                if (typeof object.content !== "string" || object.content.length)
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
        TextMsg.toObject = function toObject(message, options, q) {
            if (!options)
                options = {};
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            let object = {};
            if (options.defaults)
                object.content = "";
            if (message.content != null && Object.hasOwnProperty.call(message, "content"))
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
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
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
        ReplyRef.encode = function encode(message, writer, q) {
            if (!writer)
                writer = $Writer.create();
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.id != null && Object.hasOwnProperty.call(message, "id"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.id);
            if (message.senderId != null && Object.hasOwnProperty.call(message, "senderId"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.senderId);
            if (message.preview != null && Object.hasOwnProperty.call(message, "preview"))
                writer.uint32(/* id 3, wireType 2 =*/26).string(message.preview);
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
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
        ReplyRef.decode = function decode(reader, length, z, q, g) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (q === undefined)
                q = 0;
            if (q > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            let end = length === undefined ? reader.len : reader.pos + length, message = g || new C(), v;
            while (reader.pos < end) {
                let s = reader.pos;
                let tag = reader.tag();
                if (tag === z) {
                    z = undefined;
                    break;
                }
                let u = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (u !== 2)
                            break;
                        if ((v = reader.stringVerify()).length)
                            message.id = v;
                        else
                            delete message.id;
                        continue;
                    }
                case 2: {
                        if (u !== 2)
                            break;
                        if ((v = reader.stringVerify()).length)
                            message.senderId = v;
                        else
                            delete message.senderId;
                        continue;
                    }
                case 3: {
                        if (u !== 2)
                            break;
                        if ((v = reader.stringVerify()).length)
                            message.preview = v;
                        else
                            delete message.preview;
                        continue;
                    }
                }
                reader.skipType(u, q, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(s, reader.pos));
                }
            }
            if (z !== undefined)
                throw Error("missing end group");
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
        ReplyRef.verify = function verify(message, q) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                return "max depth exceeded";
            if (message.id != null && Object.hasOwnProperty.call(message, "id"))
                if (!$util.isString(message.id))
                    return "id: string expected";
            if (message.senderId != null && Object.hasOwnProperty.call(message, "senderId"))
                if (!$util.isString(message.senderId))
                    return "senderId: string expected";
            if (message.preview != null && Object.hasOwnProperty.call(message, "preview"))
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
        ReplyRef.fromObject = function fromObject(object, q) {
            if (object instanceof C)
                return object;
            if (!$util.isObject(object))
                throw TypeError(".canari.ReplyRef: object expected");
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            let message = new C();
            if (object.id != null)
                if (typeof object.id !== "string" || object.id.length)
                    message.id = String(object.id);
            if (object.senderId != null)
                if (typeof object.senderId !== "string" || object.senderId.length)
                    message.senderId = String(object.senderId);
            if (object.preview != null)
                if (typeof object.preview !== "string" || object.preview.length)
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
        ReplyRef.toObject = function toObject(message, options, q) {
            if (!options)
                options = {};
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            let object = {};
            if (options.defaults) {
                object.id = "";
                object.senderId = "";
                object.preview = "";
            }
            if (message.id != null && Object.hasOwnProperty.call(message, "id"))
                object.id = message.id;
            if (message.senderId != null && Object.hasOwnProperty.call(message, "senderId"))
                object.senderId = message.senderId;
            if (message.preview != null && Object.hasOwnProperty.call(message, "preview"))
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
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
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
        ReplyMsg.encode = function encode(message, writer, q) {
            if (!writer)
                writer = $Writer.create();
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.content != null && Object.hasOwnProperty.call(message, "content"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.content);
            if (message.replyTo != null && Object.hasOwnProperty.call(message, "replyTo"))
                $root.canari.ReplyRef.encode(message.replyTo, writer.uint32(/* id 2, wireType 2 =*/18).fork(), q + 1).ldelim();
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
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
        ReplyMsg.decode = function decode(reader, length, z, q, g) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (q === undefined)
                q = 0;
            if (q > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            let end = length === undefined ? reader.len : reader.pos + length, message = g || new C(), v;
            while (reader.pos < end) {
                let s = reader.pos;
                let tag = reader.tag();
                if (tag === z) {
                    z = undefined;
                    break;
                }
                let u = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (u !== 2)
                            break;
                        if ((v = reader.stringVerify()).length)
                            message.content = v;
                        else
                            delete message.content;
                        continue;
                    }
                case 2: {
                        if (u !== 2)
                            break;
                        message.replyTo = $root.canari.ReplyRef.decode(reader, reader.uint32(), undefined, q + 1, message.replyTo);
                        continue;
                    }
                }
                reader.skipType(u, q, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(s, reader.pos));
                }
            }
            if (z !== undefined)
                throw Error("missing end group");
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
        ReplyMsg.verify = function verify(message, q) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                return "max depth exceeded";
            if (message.content != null && Object.hasOwnProperty.call(message, "content"))
                if (!$util.isString(message.content))
                    return "content: string expected";
            if (message.replyTo != null && Object.hasOwnProperty.call(message, "replyTo")) {
                let error = $root.canari.ReplyRef.verify(message.replyTo, q + 1);
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
        ReplyMsg.fromObject = function fromObject(object, q) {
            if (object instanceof C)
                return object;
            if (!$util.isObject(object))
                throw TypeError(".canari.ReplyMsg: object expected");
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            let message = new C();
            if (object.content != null)
                if (typeof object.content !== "string" || object.content.length)
                    message.content = String(object.content);
            if (object.replyTo != null) {
                if (!$util.isObject(object.replyTo))
                    throw TypeError(".canari.ReplyMsg.replyTo: object expected");
                message.replyTo = $root.canari.ReplyRef.fromObject(object.replyTo, q + 1);
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
        ReplyMsg.toObject = function toObject(message, options, q) {
            if (!options)
                options = {};
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            let object = {};
            if (options.defaults) {
                object.content = "";
                object.replyTo = null;
            }
            if (message.content != null && Object.hasOwnProperty.call(message, "content"))
                object.content = message.content;
            if (message.replyTo != null && Object.hasOwnProperty.call(message, "replyTo"))
                object.replyTo = $root.canari.ReplyRef.toObject(message.replyTo, options, q + 1);
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
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
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
        ReactionMsg.encode = function encode(message, writer, q) {
            if (!writer)
                writer = $Writer.create();
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.messageId != null && Object.hasOwnProperty.call(message, "messageId"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.messageId);
            if (message.emoji != null && Object.hasOwnProperty.call(message, "emoji"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.emoji);
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
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
        ReactionMsg.decode = function decode(reader, length, z, q, g) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (q === undefined)
                q = 0;
            if (q > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            let end = length === undefined ? reader.len : reader.pos + length, message = g || new C(), v;
            while (reader.pos < end) {
                let s = reader.pos;
                let tag = reader.tag();
                if (tag === z) {
                    z = undefined;
                    break;
                }
                let u = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (u !== 2)
                            break;
                        if ((v = reader.stringVerify()).length)
                            message.messageId = v;
                        else
                            delete message.messageId;
                        continue;
                    }
                case 2: {
                        if (u !== 2)
                            break;
                        if ((v = reader.stringVerify()).length)
                            message.emoji = v;
                        else
                            delete message.emoji;
                        continue;
                    }
                }
                reader.skipType(u, q, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(s, reader.pos));
                }
            }
            if (z !== undefined)
                throw Error("missing end group");
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
        ReactionMsg.verify = function verify(message, q) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                return "max depth exceeded";
            if (message.messageId != null && Object.hasOwnProperty.call(message, "messageId"))
                if (!$util.isString(message.messageId))
                    return "messageId: string expected";
            if (message.emoji != null && Object.hasOwnProperty.call(message, "emoji"))
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
        ReactionMsg.fromObject = function fromObject(object, q) {
            if (object instanceof C)
                return object;
            if (!$util.isObject(object))
                throw TypeError(".canari.ReactionMsg: object expected");
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            let message = new C();
            if (object.messageId != null)
                if (typeof object.messageId !== "string" || object.messageId.length)
                    message.messageId = String(object.messageId);
            if (object.emoji != null)
                if (typeof object.emoji !== "string" || object.emoji.length)
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
        ReactionMsg.toObject = function toObject(message, options, q) {
            if (!options)
                options = {};
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            let object = {};
            if (options.defaults) {
                object.messageId = "";
                object.emoji = "";
            }
            if (message.messageId != null && Object.hasOwnProperty.call(message, "messageId"))
                object.messageId = message.messageId;
            if (message.emoji != null && Object.hasOwnProperty.call(message, "emoji"))
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

    canari.PollOption = (function() {

        /**
         * Properties of a PollOption.
         * @memberof canari
         * @interface IPollOption
         * @property {string|null} [id] PollOption id
         * @property {string|null} [label] PollOption label
         */

        /**
         * Constructs a new PollOption.
         * @memberof canari
         * @classdesc Represents a PollOption.
         * @implements IPollOption
         * @constructor
         * @param {canari.IPollOption=} [properties] Properties to set
         */
        function PollOption(properties) {
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        }

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
         * @param {canari.IPollOption=} [properties] Properties to set
         * @returns {canari.PollOption} PollOption instance
         */
        PollOption.create = function create(properties) {
            return new PollOption(properties);
        };

        /**
         * Encodes the specified PollOption message. Does not implicitly {@link canari.PollOption.verify|verify} messages.
         * @function encode
         * @memberof canari.PollOption
         * @static
         * @param {canari.IPollOption} message PollOption message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        PollOption.encode = function encode(message, writer, q) {
            if (!writer)
                writer = $Writer.create();
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.id != null && Object.hasOwnProperty.call(message, "id"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.id);
            if (message.label != null && Object.hasOwnProperty.call(message, "label"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.label);
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified PollOption message, length delimited. Does not implicitly {@link canari.PollOption.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.PollOption
         * @static
         * @param {canari.IPollOption} message PollOption message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        PollOption.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a PollOption message from the specified reader or buffer.
         * @function decode
         * @memberof canari.PollOption
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.PollOption} PollOption
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        PollOption.decode = function decode(reader, length, z, q, g) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (q === undefined)
                q = 0;
            if (q > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            let end = length === undefined ? reader.len : reader.pos + length, message = g || new C(), v;
            while (reader.pos < end) {
                let s = reader.pos;
                let tag = reader.tag();
                if (tag === z) {
                    z = undefined;
                    break;
                }
                let u = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (u !== 2)
                            break;
                        if ((v = reader.stringVerify()).length)
                            message.id = v;
                        else
                            delete message.id;
                        continue;
                    }
                case 2: {
                        if (u !== 2)
                            break;
                        if ((v = reader.stringVerify()).length)
                            message.label = v;
                        else
                            delete message.label;
                        continue;
                    }
                }
                reader.skipType(u, q, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(s, reader.pos));
                }
            }
            if (z !== undefined)
                throw Error("missing end group");
            return message;
        };

        /**
         * Decodes a PollOption message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.PollOption
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.PollOption} PollOption
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        PollOption.decodeDelimited = function decodeDelimited(reader) {
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
        PollOption.verify = function verify(message, q) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                return "max depth exceeded";
            if (message.id != null && Object.hasOwnProperty.call(message, "id"))
                if (!$util.isString(message.id))
                    return "id: string expected";
            if (message.label != null && Object.hasOwnProperty.call(message, "label"))
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
        PollOption.fromObject = function fromObject(object, q) {
            if (object instanceof C)
                return object;
            if (!$util.isObject(object))
                throw TypeError(".canari.PollOption: object expected");
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            let message = new C();
            if (object.id != null)
                if (typeof object.id !== "string" || object.id.length)
                    message.id = String(object.id);
            if (object.label != null)
                if (typeof object.label !== "string" || object.label.length)
                    message.label = String(object.label);
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
        PollOption.toObject = function toObject(message, options, q) {
            if (!options)
                options = {};
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            let object = {};
            if (options.defaults) {
                object.id = "";
                object.label = "";
            }
            if (message.id != null && Object.hasOwnProperty.call(message, "id"))
                object.id = message.id;
            if (message.label != null && Object.hasOwnProperty.call(message, "label"))
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
        PollOption.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for PollOption
         * @function getTypeUrl
         * @memberof canari.PollOption
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        PollOption.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/canari.PollOption";
        };

        return PollOption;
    })();

    canari.PollMsg = (function() {

        /**
         * Properties of a PollMsg.
         * @memberof canari
         * @interface IPollMsg
         * @property {string|null} [question] PollMsg question
         * @property {Array.<canari.IPollOption>|null} [options] PollMsg options
         * @property {boolean|null} [multipleChoice] PollMsg multipleChoice
         * @property {number|null} [endsAt] PollMsg endsAt
         */

        /**
         * Constructs a new PollMsg.
         * @memberof canari
         * @classdesc Represents a PollMsg.
         * @implements IPollMsg
         * @constructor
         * @param {canari.IPollMsg=} [properties] Properties to set
         */
        function PollMsg(properties) {
            this.options = [];
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * PollMsg question.
         * @member {string} question
         * @memberof canari.PollMsg
         * @instance
         */
        PollMsg.prototype.question = "";

        /**
         * PollMsg options.
         * @member {Array.<canari.IPollOption>} options
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
         * @param {canari.IPollMsg=} [properties] Properties to set
         * @returns {canari.PollMsg} PollMsg instance
         */
        PollMsg.create = function create(properties) {
            return new PollMsg(properties);
        };

        /**
         * Encodes the specified PollMsg message. Does not implicitly {@link canari.PollMsg.verify|verify} messages.
         * @function encode
         * @memberof canari.PollMsg
         * @static
         * @param {canari.IPollMsg} message PollMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        PollMsg.encode = function encode(message, writer, q) {
            if (!writer)
                writer = $Writer.create();
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.question != null && Object.hasOwnProperty.call(message, "question"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.question);
            if (message.options != null && message.options.length)
                for (let i = 0; i < message.options.length; ++i)
                    $root.canari.PollOption.encode(message.options[i], writer.uint32(/* id 2, wireType 2 =*/18).fork(), q + 1).ldelim();
            if (message.multipleChoice != null && Object.hasOwnProperty.call(message, "multipleChoice"))
                writer.uint32(/* id 3, wireType 0 =*/24).bool(message.multipleChoice);
            if (message.endsAt != null && Object.hasOwnProperty.call(message, "endsAt"))
                writer.uint32(/* id 4, wireType 0 =*/32).int64(message.endsAt);
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified PollMsg message, length delimited. Does not implicitly {@link canari.PollMsg.verify|verify} messages.
         * @function encodeDelimited
         * @memberof canari.PollMsg
         * @static
         * @param {canari.IPollMsg} message PollMsg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        PollMsg.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a PollMsg message from the specified reader or buffer.
         * @function decode
         * @memberof canari.PollMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {canari.PollMsg} PollMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        PollMsg.decode = function decode(reader, length, z, q, g) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (q === undefined)
                q = 0;
            if (q > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            let end = length === undefined ? reader.len : reader.pos + length, message = g || new C(), v;
            while (reader.pos < end) {
                let s = reader.pos;
                let tag = reader.tag();
                if (tag === z) {
                    z = undefined;
                    break;
                }
                let u = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (u !== 2)
                            break;
                        if ((v = reader.stringVerify()).length)
                            message.question = v;
                        else
                            delete message.question;
                        continue;
                    }
                case 2: {
                        if (u !== 2)
                            break;
                        if (!(message.options && message.options.length))
                            message.options = [];
                        message.options.push($root.canari.PollOption.decode(reader, reader.uint32(), undefined, q + 1));
                        continue;
                    }
                case 3: {
                        if (u !== 0)
                            break;
                        if (v = reader.bool())
                            message.multipleChoice = v;
                        else
                            delete message.multipleChoice;
                        continue;
                    }
                case 4: {
                        if (u !== 0)
                            break;
                        if (typeof (v = reader.int64()) === "object" ? v.low || v.high : v !== 0)
                            message.endsAt = v;
                        else
                            delete message.endsAt;
                        continue;
                    }
                }
                reader.skipType(u, q, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(s, reader.pos));
                }
            }
            if (z !== undefined)
                throw Error("missing end group");
            return message;
        };

        /**
         * Decodes a PollMsg message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof canari.PollMsg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {canari.PollMsg} PollMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        PollMsg.decodeDelimited = function decodeDelimited(reader) {
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
        PollMsg.verify = function verify(message, q) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                return "max depth exceeded";
            if (message.question != null && Object.hasOwnProperty.call(message, "question"))
                if (!$util.isString(message.question))
                    return "question: string expected";
            if (message.options != null && Object.hasOwnProperty.call(message, "options")) {
                if (!Array.isArray(message.options))
                    return "options: array expected";
                for (let i = 0; i < message.options.length; ++i) {
                    let error = $root.canari.PollOption.verify(message.options[i], q + 1);
                    if (error)
                        return "options." + error;
                }
            }
            if (message.multipleChoice != null && Object.hasOwnProperty.call(message, "multipleChoice"))
                if (typeof message.multipleChoice !== "boolean")
                    return "multipleChoice: boolean expected";
            if (message.endsAt != null && Object.hasOwnProperty.call(message, "endsAt"))
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
        PollMsg.fromObject = function fromObject(object, q) {
            if (object instanceof C)
                return object;
            if (!$util.isObject(object))
                throw TypeError(".canari.PollMsg: object expected");
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            let message = new C();
            if (object.question != null)
                if (typeof object.question !== "string" || object.question.length)
                    message.question = String(object.question);
            if (object.options) {
                if (!Array.isArray(object.options))
                    throw TypeError(".canari.PollMsg.options: array expected");
                message.options = Array(object.options.length);
                for (let i = 0; i < object.options.length; ++i) {
                    if (!$util.isObject(object.options[i]))
                        throw TypeError(".canari.PollMsg.options: object expected");
                    message.options[i] = $root.canari.PollOption.fromObject(object.options[i], q + 1);
                }
            }
            if (object.multipleChoice != null)
                if (object.multipleChoice)
                    message.multipleChoice = Boolean(object.multipleChoice);
            if (object.endsAt != null)
                if (typeof object.endsAt === "object" ? object.endsAt.low || object.endsAt.high : Number(object.endsAt) !== 0)
                    if ($util.Long)
                        message.endsAt = $util.Long.fromValue(object.endsAt, false);
                    else if (typeof object.endsAt === "string")
                        message.endsAt = parseInt(object.endsAt, 10);
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
        PollMsg.toObject = function toObject(message, options, q) {
            if (!options)
                options = {};
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            let object = {};
            if (options.arrays || options.defaults)
                object.options = [];
            if (options.defaults) {
                object.question = "";
                object.multipleChoice = false;
                if ($util.Long) {
                    let long = new $util.Long(0, 0, false);
                    object.endsAt = options.longs === String ? long.toString() : options.longs === Number ? long.toNumber() : typeof BigInt !== "undefined" && options.longs === BigInt ? long.toBigInt() : long;
                } else
                    object.endsAt = options.longs === String ? "0" : typeof BigInt !== "undefined" && options.longs === BigInt ? BigInt("0") : 0;
            }
            if (message.question != null && Object.hasOwnProperty.call(message, "question"))
                object.question = message.question;
            if (message.options && message.options.length) {
                object.options = Array(message.options.length);
                for (let j = 0; j < message.options.length; ++j)
                    object.options[j] = $root.canari.PollOption.toObject(message.options[j], options, q + 1);
            }
            if (message.multipleChoice != null && Object.hasOwnProperty.call(message, "multipleChoice"))
                object.multipleChoice = message.multipleChoice;
            if (message.endsAt != null && Object.hasOwnProperty.call(message, "endsAt"))
                if (typeof BigInt !== "undefined" && options.longs === BigInt)
                    object.endsAt = typeof message.endsAt === "number" ? BigInt(message.endsAt) : $util.Long.fromBits(message.endsAt.low >>> 0, message.endsAt.high >>> 0, false).toBigInt();
                else if (typeof message.endsAt === "number")
                    object.endsAt = options.longs === String ? String(message.endsAt) : message.endsAt;
                else
                    object.endsAt = options.longs === String ? $util.Long.prototype.toString.call(message.endsAt) : options.longs === Number ? new $util.LongBits(message.endsAt.low >>> 0, message.endsAt.high >>> 0).toNumber() : message.endsAt;
            return object;
        };

        /**
         * Converts this PollMsg to JSON.
         * @function toJSON
         * @memberof canari.PollMsg
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        PollMsg.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for PollMsg
         * @function getTypeUrl
         * @memberof canari.PollMsg
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        PollMsg.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/canari.PollMsg";
        };

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
         * @property {number|null} [width] MediaMsg width
         * @property {number|null} [height] MediaMsg height
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
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
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
        MediaMsg.encode = function encode(message, writer, q) {
            if (!writer)
                writer = $Writer.create();
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
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
            if (message.width != null && Object.hasOwnProperty.call(message, "width"))
                writer.uint32(/* id 9, wireType 0 =*/72).uint32(message.width);
            if (message.height != null && Object.hasOwnProperty.call(message, "height"))
                writer.uint32(/* id 10, wireType 0 =*/80).uint32(message.height);
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
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
        MediaMsg.decode = function decode(reader, length, z, q, g) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (q === undefined)
                q = 0;
            if (q > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            let end = length === undefined ? reader.len : reader.pos + length, message = g || new C(), v;
            while (reader.pos < end) {
                let s = reader.pos;
                let tag = reader.tag();
                if (tag === z) {
                    z = undefined;
                    break;
                }
                let u = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (u !== 0)
                            break;
                        if (v = reader.int32())
                            message.kind = v;
                        else
                            delete message.kind;
                        continue;
                    }
                case 2: {
                        if (u !== 2)
                            break;
                        if ((v = reader.stringVerify()).length)
                            message.mediaId = v;
                        else
                            delete message.mediaId;
                        continue;
                    }
                case 3: {
                        if (u !== 2)
                            break;
                        if ((v = reader.bytes()).length)
                            message.key = v;
                        else
                            delete message.key;
                        continue;
                    }
                case 4: {
                        if (u !== 2)
                            break;
                        if ((v = reader.bytes()).length)
                            message.iv = v;
                        else
                            delete message.iv;
                        continue;
                    }
                case 5: {
                        if (u !== 2)
                            break;
                        if ((v = reader.stringVerify()).length)
                            message.mimeType = v;
                        else
                            delete message.mimeType;
                        continue;
                    }
                case 6: {
                        if (u !== 0)
                            break;
                        if (v = reader.uint32())
                            message.size = v;
                        else
                            delete message.size;
                        continue;
                    }
                case 7: {
                        if (u !== 2)
                            break;
                        if ((v = reader.stringVerify()).length)
                            message.fileName = v;
                        else
                            delete message.fileName;
                        continue;
                    }
                case 8: {
                        if (u !== 2)
                            break;
                        if ((v = reader.stringVerify()).length)
                            message.caption = v;
                        else
                            delete message.caption;
                        continue;
                    }
                case 9: {
                        if (u !== 0)
                            break;
                        if (v = reader.uint32())
                            message.width = v;
                        else
                            delete message.width;
                        continue;
                    }
                case 10: {
                        if (u !== 0)
                            break;
                        if (v = reader.uint32())
                            message.height = v;
                        else
                            delete message.height;
                        continue;
                    }
                }
                reader.skipType(u, q, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(s, reader.pos));
                }
            }
            if (z !== undefined)
                throw Error("missing end group");
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
        MediaMsg.verify = function verify(message, q) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                return "max depth exceeded";
            if (message.kind != null && Object.hasOwnProperty.call(message, "kind"))
                switch (message.kind) {
                default:
                    return "kind: enum value expected";
                case 0:
                case 1:
                case 2:
                case 3:
                    break;
                }
            if (message.mediaId != null && Object.hasOwnProperty.call(message, "mediaId"))
                if (!$util.isString(message.mediaId))
                    return "mediaId: string expected";
            if (message.key != null && Object.hasOwnProperty.call(message, "key"))
                if (!(message.key && typeof message.key.length === "number" || $util.isString(message.key)))
                    return "key: buffer expected";
            if (message.iv != null && Object.hasOwnProperty.call(message, "iv"))
                if (!(message.iv && typeof message.iv.length === "number" || $util.isString(message.iv)))
                    return "iv: buffer expected";
            if (message.mimeType != null && Object.hasOwnProperty.call(message, "mimeType"))
                if (!$util.isString(message.mimeType))
                    return "mimeType: string expected";
            if (message.size != null && Object.hasOwnProperty.call(message, "size"))
                if (!$util.isInteger(message.size))
                    return "size: integer expected";
            if (message.fileName != null && Object.hasOwnProperty.call(message, "fileName"))
                if (!$util.isString(message.fileName))
                    return "fileName: string expected";
            if (message.caption != null && Object.hasOwnProperty.call(message, "caption"))
                if (!$util.isString(message.caption))
                    return "caption: string expected";
            if (message.width != null && Object.hasOwnProperty.call(message, "width"))
                if (!$util.isInteger(message.width))
                    return "width: integer expected";
            if (message.height != null && Object.hasOwnProperty.call(message, "height"))
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
        MediaMsg.fromObject = function fromObject(object, q) {
            if (object instanceof C)
                return object;
            if (!$util.isObject(object))
                throw TypeError(".canari.MediaMsg: object expected");
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            let message = new C();
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
                    message.mediaId = String(object.mediaId);
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
                    message.mimeType = String(object.mimeType);
            if (object.size != null)
                if (Number(object.size) !== 0)
                    message.size = object.size >>> 0;
            if (object.fileName != null)
                if (typeof object.fileName !== "string" || object.fileName.length)
                    message.fileName = String(object.fileName);
            if (object.caption != null)
                if (typeof object.caption !== "string" || object.caption.length)
                    message.caption = String(object.caption);
            if (object.width != null)
                if (Number(object.width) !== 0)
                    message.width = object.width >>> 0;
            if (object.height != null)
                if (Number(object.height) !== 0)
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
        MediaMsg.toObject = function toObject(message, options, q) {
            if (!options)
                options = {};
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
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
                object.width = 0;
                object.height = 0;
            }
            if (message.kind != null && Object.hasOwnProperty.call(message, "kind"))
                object.kind = options.enums === String ? $root.canari.MediaKind[message.kind] === undefined ? message.kind : $root.canari.MediaKind[message.kind] : message.kind;
            if (message.mediaId != null && Object.hasOwnProperty.call(message, "mediaId"))
                object.mediaId = message.mediaId;
            if (message.key != null && Object.hasOwnProperty.call(message, "key"))
                object.key = options.bytes === String ? $util.base64.encode(message.key, 0, message.key.length) : options.bytes === Array ? Array.prototype.slice.call(message.key) : message.key;
            if (message.iv != null && Object.hasOwnProperty.call(message, "iv"))
                object.iv = options.bytes === String ? $util.base64.encode(message.iv, 0, message.iv.length) : options.bytes === Array ? Array.prototype.slice.call(message.iv) : message.iv;
            if (message.mimeType != null && Object.hasOwnProperty.call(message, "mimeType"))
                object.mimeType = message.mimeType;
            if (message.size != null && Object.hasOwnProperty.call(message, "size"))
                object.size = message.size;
            if (message.fileName != null && Object.hasOwnProperty.call(message, "fileName"))
                object.fileName = message.fileName;
            if (message.caption != null && Object.hasOwnProperty.call(message, "caption"))
                object.caption = message.caption;
            if (message.width != null && Object.hasOwnProperty.call(message, "width"))
                object.width = message.width;
            if (message.height != null && Object.hasOwnProperty.call(message, "height"))
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
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
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
        SystemMsg.encode = function encode(message, writer, q) {
            if (!writer)
                writer = $Writer.create();
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.event != null && Object.hasOwnProperty.call(message, "event"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.event);
            if (message.data != null && Object.hasOwnProperty.call(message, "data"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.data);
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
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
        SystemMsg.decode = function decode(reader, length, z, q, g) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (q === undefined)
                q = 0;
            if (q > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            let end = length === undefined ? reader.len : reader.pos + length, message = g || new C(), v;
            while (reader.pos < end) {
                let s = reader.pos;
                let tag = reader.tag();
                if (tag === z) {
                    z = undefined;
                    break;
                }
                let u = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (u !== 2)
                            break;
                        if ((v = reader.stringVerify()).length)
                            message.event = v;
                        else
                            delete message.event;
                        continue;
                    }
                case 2: {
                        if (u !== 2)
                            break;
                        if ((v = reader.stringVerify()).length)
                            message.data = v;
                        else
                            delete message.data;
                        continue;
                    }
                }
                reader.skipType(u, q, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(s, reader.pos));
                }
            }
            if (z !== undefined)
                throw Error("missing end group");
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
        SystemMsg.verify = function verify(message, q) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                return "max depth exceeded";
            if (message.event != null && Object.hasOwnProperty.call(message, "event"))
                if (!$util.isString(message.event))
                    return "event: string expected";
            if (message.data != null && Object.hasOwnProperty.call(message, "data"))
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
        SystemMsg.fromObject = function fromObject(object, q) {
            if (object instanceof C)
                return object;
            if (!$util.isObject(object))
                throw TypeError(".canari.SystemMsg: object expected");
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            let message = new C();
            if (object.event != null)
                if (typeof object.event !== "string" || object.event.length)
                    message.event = String(object.event);
            if (object.data != null)
                if (typeof object.data !== "string" || object.data.length)
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
        SystemMsg.toObject = function toObject(message, options, q) {
            if (!options)
                options = {};
            if (q === undefined)
                q = 0;
            if (q > $util.recursionLimit)
                throw Error("max depth exceeded");
            let object = {};
            if (options.defaults) {
                object.event = "";
                object.data = "";
            }
            if (message.event != null && Object.hasOwnProperty.call(message, "event"))
                object.event = message.event;
            if (message.data != null && Object.hasOwnProperty.call(message, "data"))
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
