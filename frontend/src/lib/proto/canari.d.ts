import * as $protobuf from "protobufjs";
import Long = require("long");

/** Namespace canari. */
export namespace canari {

    /**
     * Properties of a WsEnvelope.
     * @deprecated Use canari.WsEnvelope.$Properties instead.
     */
    interface IWsEnvelope extends canari.WsEnvelope.$Properties {
    }

    /** Represents a WsEnvelope. */
    class WsEnvelope {

        /**
         * Constructs a new WsEnvelope.
         * @param [properties] Properties to set
         */
        constructor(properties?: canari.WsEnvelope.$Properties);

        /** Unknown fields preserved while decoding */
        $unknowns?: Uint8Array[];

        /** WsEnvelope mls. */
        mls?: (canari.MlsFrame.$Properties|null);

        /** WsEnvelope welcome. */
        welcome?: (canari.WelcomeFrame.$Properties|null);

        /** WsEnvelope read. */
        read?: (canari.ReadAck.$Properties|null);

        /** WsEnvelope body. */
        body?: ("mls"|"welcome"|"read");

        /**
         * Creates a new WsEnvelope instance using the specified properties.
         * @param [properties] Properties to set
         * @returns WsEnvelope instance
         */
        static create(properties: canari.WsEnvelope.$Shape): canari.WsEnvelope & canari.WsEnvelope.$Shape;
        static create(properties?: canari.WsEnvelope.$Properties): canari.WsEnvelope;

        /**
         * Encodes the specified WsEnvelope message. Does not implicitly {@link canari.WsEnvelope.verify|verify} messages.
         * @param message WsEnvelope message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encode(message: canari.WsEnvelope.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified WsEnvelope message, length delimited. Does not implicitly {@link canari.WsEnvelope.verify|verify} messages.
         * @param message WsEnvelope message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encodeDelimited(message: canari.WsEnvelope.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a WsEnvelope message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns {canari.WsEnvelope & canari.WsEnvelope.$Shape} WsEnvelope
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): canari.WsEnvelope & canari.WsEnvelope.$Shape;

        /**
         * Decodes a WsEnvelope message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns {canari.WsEnvelope & canari.WsEnvelope.$Shape} WsEnvelope
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): canari.WsEnvelope & canari.WsEnvelope.$Shape;

        /**
         * Verifies a WsEnvelope message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a WsEnvelope message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns WsEnvelope
         */
        static fromObject(object: { [k: string]: any }): canari.WsEnvelope;

        /**
         * Creates a plain object from a WsEnvelope message. Also converts values to other types if specified.
         * @param message WsEnvelope
         * @param [options] Conversion options
         * @returns Plain object
         */
        static toObject(message: canari.WsEnvelope, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this WsEnvelope to JSON.
         * @returns JSON object
         */
        toJSON(): { [k: string]: any };

        /**
         * Gets the type url for WsEnvelope
         * @param [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns The type url
         */
        static getTypeUrl(prefix?: string): string;
    }

    namespace WsEnvelope {

        /** Properties of a WsEnvelope. */
        interface $Properties {

            /** WsEnvelope mls */
            mls?: (canari.MlsFrame.$Properties|null);

            /** WsEnvelope welcome */
            welcome?: (canari.WelcomeFrame.$Properties|null);

            /** WsEnvelope read */
            read?: (canari.ReadAck.$Properties|null);

            /** WsEnvelope body */
            body?: ("mls"|"welcome"|"read");

            /** Unknown fields preserved while decoding */
            $unknowns?: Uint8Array[];
        }

        /** Narrowed shape of a WsEnvelope. */
        type $Shape = {
          mls?: canari.MlsFrame.$Shape|null;
          welcome?: canari.WelcomeFrame.$Shape|null;
          read?: canari.ReadAck.$Shape|null;
          $unknowns?: Uint8Array[];
        } & (
          ({ body?: undefined; mls?: null; welcome?: null; read?: null }|{ body?: "mls"; mls: canari.MlsFrame.$Shape; welcome?: null; read?: null }|{ body?: "welcome"; mls?: null; welcome: canari.WelcomeFrame.$Shape; read?: null }|{ body?: "read"; mls?: null; welcome?: null; read: canari.ReadAck.$Shape })
        );
    }

    /**
     * Properties of a Recipient.
     * @deprecated Use canari.Recipient.$Properties instead.
     */
    interface IRecipient extends canari.Recipient.$Properties {
    }

    /** Represents a Recipient. */
    class Recipient {

        /**
         * Constructs a new Recipient.
         * @param [properties] Properties to set
         */
        constructor(properties?: canari.Recipient.$Properties);

        /** Unknown fields preserved while decoding */
        $unknowns?: Uint8Array[];

        /** Recipient userId. */
        userId: string;

        /** Recipient deviceId. */
        deviceId: string;

        /**
         * Creates a new Recipient instance using the specified properties.
         * @param [properties] Properties to set
         * @returns Recipient instance
         */
        static create(properties: canari.Recipient.$Shape): canari.Recipient & canari.Recipient.$Shape;
        static create(properties?: canari.Recipient.$Properties): canari.Recipient;

        /**
         * Encodes the specified Recipient message. Does not implicitly {@link canari.Recipient.verify|verify} messages.
         * @param message Recipient message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encode(message: canari.Recipient.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified Recipient message, length delimited. Does not implicitly {@link canari.Recipient.verify|verify} messages.
         * @param message Recipient message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encodeDelimited(message: canari.Recipient.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a Recipient message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns {canari.Recipient & canari.Recipient.$Shape} Recipient
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): canari.Recipient & canari.Recipient.$Shape;

        /**
         * Decodes a Recipient message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns {canari.Recipient & canari.Recipient.$Shape} Recipient
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): canari.Recipient & canari.Recipient.$Shape;

        /**
         * Verifies a Recipient message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a Recipient message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns Recipient
         */
        static fromObject(object: { [k: string]: any }): canari.Recipient;

        /**
         * Creates a plain object from a Recipient message. Also converts values to other types if specified.
         * @param message Recipient
         * @param [options] Conversion options
         * @returns Plain object
         */
        static toObject(message: canari.Recipient, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this Recipient to JSON.
         * @returns JSON object
         */
        toJSON(): { [k: string]: any };

        /**
         * Gets the type url for Recipient
         * @param [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns The type url
         */
        static getTypeUrl(prefix?: string): string;
    }

    namespace Recipient {

        /** Properties of a Recipient. */
        interface $Properties {

            /** Recipient userId */
            userId?: (string|null);

            /** Recipient deviceId */
            deviceId?: (string|null);

            /** Unknown fields preserved while decoding */
            $unknowns?: Uint8Array[];
        }

        /** Shape of a Recipient. */
        type $Shape = canari.Recipient.$Properties;
    }

    /**
     * Properties of a MlsFrame.
     * @deprecated Use canari.MlsFrame.$Properties instead.
     */
    interface IMlsFrame extends canari.MlsFrame.$Properties {
    }

    /** Represents a MlsFrame. */
    class MlsFrame {

        /**
         * Constructs a new MlsFrame.
         * @param [properties] Properties to set
         */
        constructor(properties?: canari.MlsFrame.$Properties);

        /** Unknown fields preserved while decoding */
        $unknowns?: Uint8Array[];

        /** MlsFrame ciphertext. */
        ciphertext: Uint8Array;

        /** MlsFrame groupId. */
        groupId: string;

        /** MlsFrame recipients. */
        recipients: canari.Recipient.$Properties[];

        /**
         * Creates a new MlsFrame instance using the specified properties.
         * @param [properties] Properties to set
         * @returns MlsFrame instance
         */
        static create(properties: canari.MlsFrame.$Shape): canari.MlsFrame & canari.MlsFrame.$Shape;
        static create(properties?: canari.MlsFrame.$Properties): canari.MlsFrame;

        /**
         * Encodes the specified MlsFrame message. Does not implicitly {@link canari.MlsFrame.verify|verify} messages.
         * @param message MlsFrame message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encode(message: canari.MlsFrame.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified MlsFrame message, length delimited. Does not implicitly {@link canari.MlsFrame.verify|verify} messages.
         * @param message MlsFrame message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encodeDelimited(message: canari.MlsFrame.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a MlsFrame message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns {canari.MlsFrame & canari.MlsFrame.$Shape} MlsFrame
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): canari.MlsFrame & canari.MlsFrame.$Shape;

        /**
         * Decodes a MlsFrame message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns {canari.MlsFrame & canari.MlsFrame.$Shape} MlsFrame
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): canari.MlsFrame & canari.MlsFrame.$Shape;

        /**
         * Verifies a MlsFrame message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a MlsFrame message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns MlsFrame
         */
        static fromObject(object: { [k: string]: any }): canari.MlsFrame;

        /**
         * Creates a plain object from a MlsFrame message. Also converts values to other types if specified.
         * @param message MlsFrame
         * @param [options] Conversion options
         * @returns Plain object
         */
        static toObject(message: canari.MlsFrame, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this MlsFrame to JSON.
         * @returns JSON object
         */
        toJSON(): { [k: string]: any };

        /**
         * Gets the type url for MlsFrame
         * @param [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns The type url
         */
        static getTypeUrl(prefix?: string): string;
    }

    namespace MlsFrame {

        /** Properties of a MlsFrame. */
        interface $Properties {

            /** MlsFrame ciphertext */
            ciphertext?: (Uint8Array|null);

            /** MlsFrame groupId */
            groupId?: (string|null);

            /** MlsFrame recipients */
            recipients?: (canari.Recipient.$Properties[]|null);

            /** Unknown fields preserved while decoding */
            $unknowns?: Uint8Array[];
        }

        /** Shape of a MlsFrame. */
        type $Shape = canari.MlsFrame.$Properties;
    }

    /**
     * Properties of a WelcomeFrame.
     * @deprecated Use canari.WelcomeFrame.$Properties instead.
     */
    interface IWelcomeFrame extends canari.WelcomeFrame.$Properties {
    }

    /** Represents a WelcomeFrame. */
    class WelcomeFrame {

        /**
         * Constructs a new WelcomeFrame.
         * @param [properties] Properties to set
         */
        constructor(properties?: canari.WelcomeFrame.$Properties);

        /** Unknown fields preserved while decoding */
        $unknowns?: Uint8Array[];

        /** WelcomeFrame ciphertext. */
        ciphertext: Uint8Array;

        /** WelcomeFrame groupId. */
        groupId: string;

        /** WelcomeFrame recipients. */
        recipients: canari.Recipient.$Properties[];

        /**
         * Creates a new WelcomeFrame instance using the specified properties.
         * @param [properties] Properties to set
         * @returns WelcomeFrame instance
         */
        static create(properties: canari.WelcomeFrame.$Shape): canari.WelcomeFrame & canari.WelcomeFrame.$Shape;
        static create(properties?: canari.WelcomeFrame.$Properties): canari.WelcomeFrame;

        /**
         * Encodes the specified WelcomeFrame message. Does not implicitly {@link canari.WelcomeFrame.verify|verify} messages.
         * @param message WelcomeFrame message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encode(message: canari.WelcomeFrame.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified WelcomeFrame message, length delimited. Does not implicitly {@link canari.WelcomeFrame.verify|verify} messages.
         * @param message WelcomeFrame message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encodeDelimited(message: canari.WelcomeFrame.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a WelcomeFrame message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns {canari.WelcomeFrame & canari.WelcomeFrame.$Shape} WelcomeFrame
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): canari.WelcomeFrame & canari.WelcomeFrame.$Shape;

        /**
         * Decodes a WelcomeFrame message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns {canari.WelcomeFrame & canari.WelcomeFrame.$Shape} WelcomeFrame
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): canari.WelcomeFrame & canari.WelcomeFrame.$Shape;

        /**
         * Verifies a WelcomeFrame message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a WelcomeFrame message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns WelcomeFrame
         */
        static fromObject(object: { [k: string]: any }): canari.WelcomeFrame;

        /**
         * Creates a plain object from a WelcomeFrame message. Also converts values to other types if specified.
         * @param message WelcomeFrame
         * @param [options] Conversion options
         * @returns Plain object
         */
        static toObject(message: canari.WelcomeFrame, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this WelcomeFrame to JSON.
         * @returns JSON object
         */
        toJSON(): { [k: string]: any };

        /**
         * Gets the type url for WelcomeFrame
         * @param [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns The type url
         */
        static getTypeUrl(prefix?: string): string;
    }

    namespace WelcomeFrame {

        /** Properties of a WelcomeFrame. */
        interface $Properties {

            /** WelcomeFrame ciphertext */
            ciphertext?: (Uint8Array|null);

            /** WelcomeFrame groupId */
            groupId?: (string|null);

            /** WelcomeFrame recipients */
            recipients?: (canari.Recipient.$Properties[]|null);

            /** Unknown fields preserved while decoding */
            $unknowns?: Uint8Array[];
        }

        /** Shape of a WelcomeFrame. */
        type $Shape = canari.WelcomeFrame.$Properties;
    }

    /**
     * Properties of a ReadAck.
     * @deprecated Use canari.ReadAck.$Properties instead.
     */
    interface IReadAck extends canari.ReadAck.$Properties {
    }

    /** Represents a ReadAck. */
    class ReadAck {

        /**
         * Constructs a new ReadAck.
         * @param [properties] Properties to set
         */
        constructor(properties?: canari.ReadAck.$Properties);

        /** Unknown fields preserved while decoding */
        $unknowns?: Uint8Array[];

        /** ReadAck messageId. */
        messageId: string;

        /**
         * Creates a new ReadAck instance using the specified properties.
         * @param [properties] Properties to set
         * @returns ReadAck instance
         */
        static create(properties: canari.ReadAck.$Shape): canari.ReadAck & canari.ReadAck.$Shape;
        static create(properties?: canari.ReadAck.$Properties): canari.ReadAck;

        /**
         * Encodes the specified ReadAck message. Does not implicitly {@link canari.ReadAck.verify|verify} messages.
         * @param message ReadAck message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encode(message: canari.ReadAck.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified ReadAck message, length delimited. Does not implicitly {@link canari.ReadAck.verify|verify} messages.
         * @param message ReadAck message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encodeDelimited(message: canari.ReadAck.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a ReadAck message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns {canari.ReadAck & canari.ReadAck.$Shape} ReadAck
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): canari.ReadAck & canari.ReadAck.$Shape;

        /**
         * Decodes a ReadAck message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns {canari.ReadAck & canari.ReadAck.$Shape} ReadAck
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): canari.ReadAck & canari.ReadAck.$Shape;

        /**
         * Verifies a ReadAck message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a ReadAck message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns ReadAck
         */
        static fromObject(object: { [k: string]: any }): canari.ReadAck;

        /**
         * Creates a plain object from a ReadAck message. Also converts values to other types if specified.
         * @param message ReadAck
         * @param [options] Conversion options
         * @returns Plain object
         */
        static toObject(message: canari.ReadAck, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this ReadAck to JSON.
         * @returns JSON object
         */
        toJSON(): { [k: string]: any };

        /**
         * Gets the type url for ReadAck
         * @param [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns The type url
         */
        static getTypeUrl(prefix?: string): string;
    }

    namespace ReadAck {

        /** Properties of a ReadAck. */
        interface $Properties {

            /** ReadAck messageId */
            messageId?: (string|null);

            /** Unknown fields preserved while decoding */
            $unknowns?: Uint8Array[];
        }

        /** Shape of a ReadAck. */
        type $Shape = canari.ReadAck.$Properties;
    }

    /**
     * Properties of an InboundMsg.
     * @deprecated Use canari.InboundMsg.$Properties instead.
     */
    interface IInboundMsg extends canari.InboundMsg.$Properties {
    }

    /** Represents an InboundMsg. */
    class InboundMsg {

        /**
         * Constructs a new InboundMsg.
         * @param [properties] Properties to set
         */
        constructor(properties?: canari.InboundMsg.$Properties);

        /** Unknown fields preserved while decoding */
        $unknowns?: Uint8Array[];

        /** InboundMsg ciphertext. */
        ciphertext: Uint8Array;

        /** InboundMsg senderId. */
        senderId: string;

        /** InboundMsg senderDeviceId. */
        senderDeviceId: string;

        /** InboundMsg groupId. */
        groupId: string;

        /** InboundMsg isWelcome. */
        isWelcome: boolean;

        /** InboundMsg isCommit. */
        isCommit: boolean;

        /**
         * Creates a new InboundMsg instance using the specified properties.
         * @param [properties] Properties to set
         * @returns InboundMsg instance
         */
        static create(properties: canari.InboundMsg.$Shape): canari.InboundMsg & canari.InboundMsg.$Shape;
        static create(properties?: canari.InboundMsg.$Properties): canari.InboundMsg;

        /**
         * Encodes the specified InboundMsg message. Does not implicitly {@link canari.InboundMsg.verify|verify} messages.
         * @param message InboundMsg message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encode(message: canari.InboundMsg.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified InboundMsg message, length delimited. Does not implicitly {@link canari.InboundMsg.verify|verify} messages.
         * @param message InboundMsg message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encodeDelimited(message: canari.InboundMsg.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes an InboundMsg message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns {canari.InboundMsg & canari.InboundMsg.$Shape} InboundMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): canari.InboundMsg & canari.InboundMsg.$Shape;

        /**
         * Decodes an InboundMsg message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns {canari.InboundMsg & canari.InboundMsg.$Shape} InboundMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): canari.InboundMsg & canari.InboundMsg.$Shape;

        /**
         * Verifies an InboundMsg message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates an InboundMsg message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns InboundMsg
         */
        static fromObject(object: { [k: string]: any }): canari.InboundMsg;

        /**
         * Creates a plain object from an InboundMsg message. Also converts values to other types if specified.
         * @param message InboundMsg
         * @param [options] Conversion options
         * @returns Plain object
         */
        static toObject(message: canari.InboundMsg, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this InboundMsg to JSON.
         * @returns JSON object
         */
        toJSON(): { [k: string]: any };

        /**
         * Gets the type url for InboundMsg
         * @param [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns The type url
         */
        static getTypeUrl(prefix?: string): string;
    }

    namespace InboundMsg {

        /** Properties of an InboundMsg. */
        interface $Properties {

            /** InboundMsg ciphertext */
            ciphertext?: (Uint8Array|null);

            /** InboundMsg senderId */
            senderId?: (string|null);

            /** InboundMsg senderDeviceId */
            senderDeviceId?: (string|null);

            /** InboundMsg groupId */
            groupId?: (string|null);

            /** InboundMsg isWelcome */
            isWelcome?: (boolean|null);

            /** InboundMsg isCommit */
            isCommit?: (boolean|null);

            /** Unknown fields preserved while decoding */
            $unknowns?: Uint8Array[];
        }

        /** Shape of an InboundMsg. */
        type $Shape = canari.InboundMsg.$Properties;
    }

    /**
     * Properties of an AppMessage.
     * @deprecated Use canari.AppMessage.$Properties instead.
     */
    interface IAppMessage extends canari.AppMessage.$Properties {
    }

    /** Represents an AppMessage. */
    class AppMessage {

        /**
         * Constructs a new AppMessage.
         * @param [properties] Properties to set
         */
        constructor(properties?: canari.AppMessage.$Properties);

        /** Unknown fields preserved while decoding */
        $unknowns?: Uint8Array[];

        /** AppMessage messageId. */
        messageId: string;

        /** AppMessage sentAt. */
        sentAt: number;

        /** AppMessage text. */
        text?: (canari.TextMsg.$Properties|null);

        /** AppMessage reply. */
        reply?: (canari.ReplyMsg.$Properties|null);

        /** AppMessage reaction. */
        reaction?: (canari.ReactionMsg.$Properties|null);

        /** AppMessage media. */
        media?: (canari.MediaMsg.$Properties|null);

        /** AppMessage system. */
        system?: (canari.SystemMsg.$Properties|null);

        /** AppMessage call. */
        call?: (canari.CallMsg.$Properties|null);

        /** AppMessage poll. */
        poll?: (canari.PollMsg.$Properties|null);

        /** AppMessage kind. */
        kind?: ("text"|"reply"|"reaction"|"media"|"system"|"call"|"poll");

        /**
         * Creates a new AppMessage instance using the specified properties.
         * @param [properties] Properties to set
         * @returns AppMessage instance
         */
        static create(properties: canari.AppMessage.$Shape): canari.AppMessage & canari.AppMessage.$Shape;
        static create(properties?: canari.AppMessage.$Properties): canari.AppMessage;

        /**
         * Encodes the specified AppMessage message. Does not implicitly {@link canari.AppMessage.verify|verify} messages.
         * @param message AppMessage message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encode(message: canari.AppMessage.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified AppMessage message, length delimited. Does not implicitly {@link canari.AppMessage.verify|verify} messages.
         * @param message AppMessage message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encodeDelimited(message: canari.AppMessage.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes an AppMessage message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns {canari.AppMessage & canari.AppMessage.$Shape} AppMessage
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): canari.AppMessage & canari.AppMessage.$Shape;

        /**
         * Decodes an AppMessage message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns {canari.AppMessage & canari.AppMessage.$Shape} AppMessage
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): canari.AppMessage & canari.AppMessage.$Shape;

        /**
         * Verifies an AppMessage message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates an AppMessage message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns AppMessage
         */
        static fromObject(object: { [k: string]: any }): canari.AppMessage;

        /**
         * Creates a plain object from an AppMessage message. Also converts values to other types if specified.
         * @param message AppMessage
         * @param [options] Conversion options
         * @returns Plain object
         */
        static toObject(message: canari.AppMessage, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this AppMessage to JSON.
         * @returns JSON object
         */
        toJSON(): { [k: string]: any };

        /**
         * Gets the type url for AppMessage
         * @param [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns The type url
         */
        static getTypeUrl(prefix?: string): string;
    }

    namespace AppMessage {

        /** Properties of an AppMessage. */
        interface $Properties {

            /** AppMessage messageId */
            messageId?: (string|null);

            /** AppMessage sentAt */
            sentAt?: (number|null);

            /** AppMessage text */
            text?: (canari.TextMsg.$Properties|null);

            /** AppMessage reply */
            reply?: (canari.ReplyMsg.$Properties|null);

            /** AppMessage reaction */
            reaction?: (canari.ReactionMsg.$Properties|null);

            /** AppMessage media */
            media?: (canari.MediaMsg.$Properties|null);

            /** AppMessage system */
            system?: (canari.SystemMsg.$Properties|null);

            /** AppMessage call */
            call?: (canari.CallMsg.$Properties|null);

            /** AppMessage poll */
            poll?: (canari.PollMsg.$Properties|null);

            /** AppMessage kind */
            kind?: ("text"|"reply"|"reaction"|"media"|"system"|"call"|"poll");

            /** Unknown fields preserved while decoding */
            $unknowns?: Uint8Array[];
        }

        /** Narrowed shape of an AppMessage. */
        type $Shape = {
          messageId?: string|null;
          sentAt?: number|null;
          text?: canari.TextMsg.$Shape|null;
          reply?: canari.ReplyMsg.$Shape|null;
          reaction?: canari.ReactionMsg.$Shape|null;
          media?: canari.MediaMsg.$Shape|null;
          system?: canari.SystemMsg.$Shape|null;
          call?: canari.CallMsg.$Shape|null;
          poll?: canari.PollMsg.$Shape|null;
          $unknowns?: Uint8Array[];
        } & (
          ({ kind?: undefined; text?: null; reply?: null; reaction?: null; media?: null; system?: null; call?: null; poll?: null }|{ kind?: "text"; text: canari.TextMsg.$Shape; reply?: null; reaction?: null; media?: null; system?: null; call?: null; poll?: null }|{ kind?: "reply"; text?: null; reply: canari.ReplyMsg.$Shape; reaction?: null; media?: null; system?: null; call?: null; poll?: null }|{ kind?: "reaction"; text?: null; reply?: null; reaction: canari.ReactionMsg.$Shape; media?: null; system?: null; call?: null; poll?: null }|{ kind?: "media"; text?: null; reply?: null; reaction?: null; media: canari.MediaMsg.$Shape; system?: null; call?: null; poll?: null }|{ kind?: "system"; text?: null; reply?: null; reaction?: null; media?: null; system: canari.SystemMsg.$Shape; call?: null; poll?: null }|{ kind?: "call"; text?: null; reply?: null; reaction?: null; media?: null; system?: null; call: canari.CallMsg.$Shape; poll?: null }|{ kind?: "poll"; text?: null; reply?: null; reaction?: null; media?: null; system?: null; call?: null; poll: canari.PollMsg.$Shape })
        );
    }

    /**
     * Properties of a CallMsg.
     * @deprecated Use canari.CallMsg.$Properties instead.
     */
    interface ICallMsg extends canari.CallMsg.$Properties {
    }

    /** Represents a CallMsg. */
    class CallMsg {

        /**
         * Constructs a new CallMsg.
         * @param [properties] Properties to set
         */
        constructor(properties?: canari.CallMsg.$Properties);

        /** Unknown fields preserved while decoding */
        $unknowns?: Uint8Array[];

        /** CallMsg callId. */
        callId: string;

        /** CallMsg hasVideo. */
        hasVideo: boolean;

        /** CallMsg deviceId. */
        deviceId: string;

        /** CallMsg offerSdp. */
        offerSdp?: (string|null);

        /** CallMsg answerSdp. */
        answerSdp?: (string|null);

        /** CallMsg iceCandidate. */
        iceCandidate?: (string|null);

        /** CallMsg hangup. */
        hangup?: (boolean|null);

        /** CallMsg answered. */
        answered?: (boolean|null);

        /** CallMsg payload. */
        payload?: ("offerSdp"|"answerSdp"|"iceCandidate"|"hangup"|"answered");

        /**
         * Creates a new CallMsg instance using the specified properties.
         * @param [properties] Properties to set
         * @returns CallMsg instance
         */
        static create(properties: canari.CallMsg.$Shape): canari.CallMsg & canari.CallMsg.$Shape;
        static create(properties?: canari.CallMsg.$Properties): canari.CallMsg;

        /**
         * Encodes the specified CallMsg message. Does not implicitly {@link canari.CallMsg.verify|verify} messages.
         * @param message CallMsg message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encode(message: canari.CallMsg.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified CallMsg message, length delimited. Does not implicitly {@link canari.CallMsg.verify|verify} messages.
         * @param message CallMsg message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encodeDelimited(message: canari.CallMsg.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a CallMsg message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns {canari.CallMsg & canari.CallMsg.$Shape} CallMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): canari.CallMsg & canari.CallMsg.$Shape;

        /**
         * Decodes a CallMsg message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns {canari.CallMsg & canari.CallMsg.$Shape} CallMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): canari.CallMsg & canari.CallMsg.$Shape;

        /**
         * Verifies a CallMsg message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a CallMsg message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns CallMsg
         */
        static fromObject(object: { [k: string]: any }): canari.CallMsg;

        /**
         * Creates a plain object from a CallMsg message. Also converts values to other types if specified.
         * @param message CallMsg
         * @param [options] Conversion options
         * @returns Plain object
         */
        static toObject(message: canari.CallMsg, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this CallMsg to JSON.
         * @returns JSON object
         */
        toJSON(): { [k: string]: any };

        /**
         * Gets the type url for CallMsg
         * @param [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns The type url
         */
        static getTypeUrl(prefix?: string): string;
    }

    namespace CallMsg {

        /** Properties of a CallMsg. */
        interface $Properties {

            /** CallMsg callId */
            callId?: (string|null);

            /** CallMsg hasVideo */
            hasVideo?: (boolean|null);

            /** CallMsg deviceId */
            deviceId?: (string|null);

            /** CallMsg offerSdp */
            offerSdp?: (string|null);

            /** CallMsg answerSdp */
            answerSdp?: (string|null);

            /** CallMsg iceCandidate */
            iceCandidate?: (string|null);

            /** CallMsg hangup */
            hangup?: (boolean|null);

            /** CallMsg answered */
            answered?: (boolean|null);

            /** CallMsg payload */
            payload?: ("offerSdp"|"answerSdp"|"iceCandidate"|"hangup"|"answered");

            /** Unknown fields preserved while decoding */
            $unknowns?: Uint8Array[];
        }

        /** Narrowed shape of a CallMsg. */
        type $Shape = {
          callId?: string|null;
          hasVideo?: boolean|null;
          deviceId?: string|null;
          offerSdp?: string|null;
          answerSdp?: string|null;
          iceCandidate?: string|null;
          hangup?: boolean|null;
          answered?: boolean|null;
          $unknowns?: Uint8Array[];
        } & (
          ({ payload?: undefined; offerSdp?: null; answerSdp?: null; iceCandidate?: null; hangup?: null; answered?: null }|{ payload?: "offerSdp"; offerSdp: string; answerSdp?: null; iceCandidate?: null; hangup?: null; answered?: null }|{ payload?: "answerSdp"; offerSdp?: null; answerSdp: string; iceCandidate?: null; hangup?: null; answered?: null }|{ payload?: "iceCandidate"; offerSdp?: null; answerSdp?: null; iceCandidate: string; hangup?: null; answered?: null }|{ payload?: "hangup"; offerSdp?: null; answerSdp?: null; iceCandidate?: null; hangup: boolean; answered?: null }|{ payload?: "answered"; offerSdp?: null; answerSdp?: null; iceCandidate?: null; hangup?: null; answered: boolean })
        );
    }

    /**
     * Properties of a TextMsg.
     * @deprecated Use canari.TextMsg.$Properties instead.
     */
    interface ITextMsg extends canari.TextMsg.$Properties {
    }

    /** Represents a TextMsg. */
    class TextMsg {

        /**
         * Constructs a new TextMsg.
         * @param [properties] Properties to set
         */
        constructor(properties?: canari.TextMsg.$Properties);

        /** Unknown fields preserved while decoding */
        $unknowns?: Uint8Array[];

        /** TextMsg content. */
        content: string;

        /**
         * Creates a new TextMsg instance using the specified properties.
         * @param [properties] Properties to set
         * @returns TextMsg instance
         */
        static create(properties: canari.TextMsg.$Shape): canari.TextMsg & canari.TextMsg.$Shape;
        static create(properties?: canari.TextMsg.$Properties): canari.TextMsg;

        /**
         * Encodes the specified TextMsg message. Does not implicitly {@link canari.TextMsg.verify|verify} messages.
         * @param message TextMsg message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encode(message: canari.TextMsg.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified TextMsg message, length delimited. Does not implicitly {@link canari.TextMsg.verify|verify} messages.
         * @param message TextMsg message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encodeDelimited(message: canari.TextMsg.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a TextMsg message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns {canari.TextMsg & canari.TextMsg.$Shape} TextMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): canari.TextMsg & canari.TextMsg.$Shape;

        /**
         * Decodes a TextMsg message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns {canari.TextMsg & canari.TextMsg.$Shape} TextMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): canari.TextMsg & canari.TextMsg.$Shape;

        /**
         * Verifies a TextMsg message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a TextMsg message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns TextMsg
         */
        static fromObject(object: { [k: string]: any }): canari.TextMsg;

        /**
         * Creates a plain object from a TextMsg message. Also converts values to other types if specified.
         * @param message TextMsg
         * @param [options] Conversion options
         * @returns Plain object
         */
        static toObject(message: canari.TextMsg, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this TextMsg to JSON.
         * @returns JSON object
         */
        toJSON(): { [k: string]: any };

        /**
         * Gets the type url for TextMsg
         * @param [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns The type url
         */
        static getTypeUrl(prefix?: string): string;
    }

    namespace TextMsg {

        /** Properties of a TextMsg. */
        interface $Properties {

            /** TextMsg content */
            content?: (string|null);

            /** Unknown fields preserved while decoding */
            $unknowns?: Uint8Array[];
        }

        /** Shape of a TextMsg. */
        type $Shape = canari.TextMsg.$Properties;
    }

    /**
     * Properties of a ReplyRef.
     * @deprecated Use canari.ReplyRef.$Properties instead.
     */
    interface IReplyRef extends canari.ReplyRef.$Properties {
    }

    /** Represents a ReplyRef. */
    class ReplyRef {

        /**
         * Constructs a new ReplyRef.
         * @param [properties] Properties to set
         */
        constructor(properties?: canari.ReplyRef.$Properties);

        /** Unknown fields preserved while decoding */
        $unknowns?: Uint8Array[];

        /** ReplyRef id. */
        id: string;

        /** ReplyRef senderId. */
        senderId: string;

        /** ReplyRef preview. */
        preview: string;

        /**
         * Creates a new ReplyRef instance using the specified properties.
         * @param [properties] Properties to set
         * @returns ReplyRef instance
         */
        static create(properties: canari.ReplyRef.$Shape): canari.ReplyRef & canari.ReplyRef.$Shape;
        static create(properties?: canari.ReplyRef.$Properties): canari.ReplyRef;

        /**
         * Encodes the specified ReplyRef message. Does not implicitly {@link canari.ReplyRef.verify|verify} messages.
         * @param message ReplyRef message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encode(message: canari.ReplyRef.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified ReplyRef message, length delimited. Does not implicitly {@link canari.ReplyRef.verify|verify} messages.
         * @param message ReplyRef message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encodeDelimited(message: canari.ReplyRef.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a ReplyRef message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns {canari.ReplyRef & canari.ReplyRef.$Shape} ReplyRef
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): canari.ReplyRef & canari.ReplyRef.$Shape;

        /**
         * Decodes a ReplyRef message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns {canari.ReplyRef & canari.ReplyRef.$Shape} ReplyRef
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): canari.ReplyRef & canari.ReplyRef.$Shape;

        /**
         * Verifies a ReplyRef message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a ReplyRef message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns ReplyRef
         */
        static fromObject(object: { [k: string]: any }): canari.ReplyRef;

        /**
         * Creates a plain object from a ReplyRef message. Also converts values to other types if specified.
         * @param message ReplyRef
         * @param [options] Conversion options
         * @returns Plain object
         */
        static toObject(message: canari.ReplyRef, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this ReplyRef to JSON.
         * @returns JSON object
         */
        toJSON(): { [k: string]: any };

        /**
         * Gets the type url for ReplyRef
         * @param [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns The type url
         */
        static getTypeUrl(prefix?: string): string;
    }

    namespace ReplyRef {

        /** Properties of a ReplyRef. */
        interface $Properties {

            /** ReplyRef id */
            id?: (string|null);

            /** ReplyRef senderId */
            senderId?: (string|null);

            /** ReplyRef preview */
            preview?: (string|null);

            /** Unknown fields preserved while decoding */
            $unknowns?: Uint8Array[];
        }

        /** Shape of a ReplyRef. */
        type $Shape = canari.ReplyRef.$Properties;
    }

    /**
     * Properties of a ReplyMsg.
     * @deprecated Use canari.ReplyMsg.$Properties instead.
     */
    interface IReplyMsg extends canari.ReplyMsg.$Properties {
    }

    /** Represents a ReplyMsg. */
    class ReplyMsg {

        /**
         * Constructs a new ReplyMsg.
         * @param [properties] Properties to set
         */
        constructor(properties?: canari.ReplyMsg.$Properties);

        /** Unknown fields preserved while decoding */
        $unknowns?: Uint8Array[];

        /** ReplyMsg content. */
        content: string;

        /** ReplyMsg replyTo. */
        replyTo?: (canari.ReplyRef.$Properties|null);

        /**
         * Creates a new ReplyMsg instance using the specified properties.
         * @param [properties] Properties to set
         * @returns ReplyMsg instance
         */
        static create(properties: canari.ReplyMsg.$Shape): canari.ReplyMsg & canari.ReplyMsg.$Shape;
        static create(properties?: canari.ReplyMsg.$Properties): canari.ReplyMsg;

        /**
         * Encodes the specified ReplyMsg message. Does not implicitly {@link canari.ReplyMsg.verify|verify} messages.
         * @param message ReplyMsg message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encode(message: canari.ReplyMsg.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified ReplyMsg message, length delimited. Does not implicitly {@link canari.ReplyMsg.verify|verify} messages.
         * @param message ReplyMsg message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encodeDelimited(message: canari.ReplyMsg.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a ReplyMsg message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns {canari.ReplyMsg & canari.ReplyMsg.$Shape} ReplyMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): canari.ReplyMsg & canari.ReplyMsg.$Shape;

        /**
         * Decodes a ReplyMsg message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns {canari.ReplyMsg & canari.ReplyMsg.$Shape} ReplyMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): canari.ReplyMsg & canari.ReplyMsg.$Shape;

        /**
         * Verifies a ReplyMsg message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a ReplyMsg message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns ReplyMsg
         */
        static fromObject(object: { [k: string]: any }): canari.ReplyMsg;

        /**
         * Creates a plain object from a ReplyMsg message. Also converts values to other types if specified.
         * @param message ReplyMsg
         * @param [options] Conversion options
         * @returns Plain object
         */
        static toObject(message: canari.ReplyMsg, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this ReplyMsg to JSON.
         * @returns JSON object
         */
        toJSON(): { [k: string]: any };

        /**
         * Gets the type url for ReplyMsg
         * @param [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns The type url
         */
        static getTypeUrl(prefix?: string): string;
    }

    namespace ReplyMsg {

        /** Properties of a ReplyMsg. */
        interface $Properties {

            /** ReplyMsg content */
            content?: (string|null);

            /** ReplyMsg replyTo */
            replyTo?: (canari.ReplyRef.$Properties|null);

            /** Unknown fields preserved while decoding */
            $unknowns?: Uint8Array[];
        }

        /** Shape of a ReplyMsg. */
        type $Shape = canari.ReplyMsg.$Properties;
    }

    /**
     * Properties of a ReactionMsg.
     * @deprecated Use canari.ReactionMsg.$Properties instead.
     */
    interface IReactionMsg extends canari.ReactionMsg.$Properties {
    }

    /** Represents a ReactionMsg. */
    class ReactionMsg {

        /**
         * Constructs a new ReactionMsg.
         * @param [properties] Properties to set
         */
        constructor(properties?: canari.ReactionMsg.$Properties);

        /** Unknown fields preserved while decoding */
        $unknowns?: Uint8Array[];

        /** ReactionMsg messageId. */
        messageId: string;

        /** ReactionMsg emoji. */
        emoji: string;

        /**
         * Creates a new ReactionMsg instance using the specified properties.
         * @param [properties] Properties to set
         * @returns ReactionMsg instance
         */
        static create(properties: canari.ReactionMsg.$Shape): canari.ReactionMsg & canari.ReactionMsg.$Shape;
        static create(properties?: canari.ReactionMsg.$Properties): canari.ReactionMsg;

        /**
         * Encodes the specified ReactionMsg message. Does not implicitly {@link canari.ReactionMsg.verify|verify} messages.
         * @param message ReactionMsg message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encode(message: canari.ReactionMsg.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified ReactionMsg message, length delimited. Does not implicitly {@link canari.ReactionMsg.verify|verify} messages.
         * @param message ReactionMsg message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encodeDelimited(message: canari.ReactionMsg.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a ReactionMsg message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns {canari.ReactionMsg & canari.ReactionMsg.$Shape} ReactionMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): canari.ReactionMsg & canari.ReactionMsg.$Shape;

        /**
         * Decodes a ReactionMsg message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns {canari.ReactionMsg & canari.ReactionMsg.$Shape} ReactionMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): canari.ReactionMsg & canari.ReactionMsg.$Shape;

        /**
         * Verifies a ReactionMsg message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a ReactionMsg message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns ReactionMsg
         */
        static fromObject(object: { [k: string]: any }): canari.ReactionMsg;

        /**
         * Creates a plain object from a ReactionMsg message. Also converts values to other types if specified.
         * @param message ReactionMsg
         * @param [options] Conversion options
         * @returns Plain object
         */
        static toObject(message: canari.ReactionMsg, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this ReactionMsg to JSON.
         * @returns JSON object
         */
        toJSON(): { [k: string]: any };

        /**
         * Gets the type url for ReactionMsg
         * @param [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns The type url
         */
        static getTypeUrl(prefix?: string): string;
    }

    namespace ReactionMsg {

        /** Properties of a ReactionMsg. */
        interface $Properties {

            /** ReactionMsg messageId */
            messageId?: (string|null);

            /** ReactionMsg emoji */
            emoji?: (string|null);

            /** Unknown fields preserved while decoding */
            $unknowns?: Uint8Array[];
        }

        /** Shape of a ReactionMsg. */
        type $Shape = canari.ReactionMsg.$Properties;
    }

    /**
     * Properties of a PollOption.
     * @deprecated Use canari.PollOption.$Properties instead.
     */
    interface IPollOption extends canari.PollOption.$Properties {
    }

    /** Represents a PollOption. */
    class PollOption {

        /**
         * Constructs a new PollOption.
         * @param [properties] Properties to set
         */
        constructor(properties?: canari.PollOption.$Properties);

        /** Unknown fields preserved while decoding */
        $unknowns?: Uint8Array[];

        /** PollOption id. */
        id: string;

        /** PollOption label. */
        label: string;

        /**
         * Creates a new PollOption instance using the specified properties.
         * @param [properties] Properties to set
         * @returns PollOption instance
         */
        static create(properties: canari.PollOption.$Shape): canari.PollOption & canari.PollOption.$Shape;
        static create(properties?: canari.PollOption.$Properties): canari.PollOption;

        /**
         * Encodes the specified PollOption message. Does not implicitly {@link canari.PollOption.verify|verify} messages.
         * @param message PollOption message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encode(message: canari.PollOption.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified PollOption message, length delimited. Does not implicitly {@link canari.PollOption.verify|verify} messages.
         * @param message PollOption message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encodeDelimited(message: canari.PollOption.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a PollOption message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns {canari.PollOption & canari.PollOption.$Shape} PollOption
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): canari.PollOption & canari.PollOption.$Shape;

        /**
         * Decodes a PollOption message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns {canari.PollOption & canari.PollOption.$Shape} PollOption
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): canari.PollOption & canari.PollOption.$Shape;

        /**
         * Verifies a PollOption message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a PollOption message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns PollOption
         */
        static fromObject(object: { [k: string]: any }): canari.PollOption;

        /**
         * Creates a plain object from a PollOption message. Also converts values to other types if specified.
         * @param message PollOption
         * @param [options] Conversion options
         * @returns Plain object
         */
        static toObject(message: canari.PollOption, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this PollOption to JSON.
         * @returns JSON object
         */
        toJSON(): { [k: string]: any };

        /**
         * Gets the type url for PollOption
         * @param [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns The type url
         */
        static getTypeUrl(prefix?: string): string;
    }

    namespace PollOption {

        /** Properties of a PollOption. */
        interface $Properties {

            /** PollOption id */
            id?: (string|null);

            /** PollOption label */
            label?: (string|null);

            /** Unknown fields preserved while decoding */
            $unknowns?: Uint8Array[];
        }

        /** Shape of a PollOption. */
        type $Shape = canari.PollOption.$Properties;
    }

    /**
     * Properties of a PollMsg.
     * @deprecated Use canari.PollMsg.$Properties instead.
     */
    interface IPollMsg extends canari.PollMsg.$Properties {
    }

    /** Represents a PollMsg. */
    class PollMsg {

        /**
         * Constructs a new PollMsg.
         * @param [properties] Properties to set
         */
        constructor(properties?: canari.PollMsg.$Properties);

        /** Unknown fields preserved while decoding */
        $unknowns?: Uint8Array[];

        /** PollMsg question. */
        question: string;

        /** PollMsg options. */
        options: canari.PollOption.$Properties[];

        /** PollMsg multipleChoice. */
        multipleChoice: boolean;

        /** PollMsg endsAt. */
        endsAt: number;

        /**
         * Creates a new PollMsg instance using the specified properties.
         * @param [properties] Properties to set
         * @returns PollMsg instance
         */
        static create(properties: canari.PollMsg.$Shape): canari.PollMsg & canari.PollMsg.$Shape;
        static create(properties?: canari.PollMsg.$Properties): canari.PollMsg;

        /**
         * Encodes the specified PollMsg message. Does not implicitly {@link canari.PollMsg.verify|verify} messages.
         * @param message PollMsg message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encode(message: canari.PollMsg.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified PollMsg message, length delimited. Does not implicitly {@link canari.PollMsg.verify|verify} messages.
         * @param message PollMsg message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encodeDelimited(message: canari.PollMsg.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a PollMsg message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns {canari.PollMsg & canari.PollMsg.$Shape} PollMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): canari.PollMsg & canari.PollMsg.$Shape;

        /**
         * Decodes a PollMsg message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns {canari.PollMsg & canari.PollMsg.$Shape} PollMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): canari.PollMsg & canari.PollMsg.$Shape;

        /**
         * Verifies a PollMsg message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a PollMsg message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns PollMsg
         */
        static fromObject(object: { [k: string]: any }): canari.PollMsg;

        /**
         * Creates a plain object from a PollMsg message. Also converts values to other types if specified.
         * @param message PollMsg
         * @param [options] Conversion options
         * @returns Plain object
         */
        static toObject(message: canari.PollMsg, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this PollMsg to JSON.
         * @returns JSON object
         */
        toJSON(): { [k: string]: any };

        /**
         * Gets the type url for PollMsg
         * @param [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns The type url
         */
        static getTypeUrl(prefix?: string): string;
    }

    namespace PollMsg {

        /** Properties of a PollMsg. */
        interface $Properties {

            /** PollMsg question */
            question?: (string|null);

            /** PollMsg options */
            options?: (canari.PollOption.$Properties[]|null);

            /** PollMsg multipleChoice */
            multipleChoice?: (boolean|null);

            /** PollMsg endsAt */
            endsAt?: (number|null);

            /** Unknown fields preserved while decoding */
            $unknowns?: Uint8Array[];
        }

        /** Shape of a PollMsg. */
        type $Shape = canari.PollMsg.$Properties;
    }

    /** MediaKind enum. */
    enum MediaKind {

        /** MEDIA_FILE value */
        MEDIA_FILE = 0,

        /** MEDIA_IMAGE value */
        MEDIA_IMAGE = 1,

        /** MEDIA_VIDEO value */
        MEDIA_VIDEO = 2,

        /** MEDIA_AUDIO value */
        MEDIA_AUDIO = 3
    }

    /**
     * Properties of a MediaMsg.
     * @deprecated Use canari.MediaMsg.$Properties instead.
     */
    interface IMediaMsg extends canari.MediaMsg.$Properties {
    }

    /** Represents a MediaMsg. */
    class MediaMsg {

        /**
         * Constructs a new MediaMsg.
         * @param [properties] Properties to set
         */
        constructor(properties?: canari.MediaMsg.$Properties);

        /** Unknown fields preserved while decoding */
        $unknowns?: Uint8Array[];

        /** MediaMsg kind. */
        kind: canari.MediaKind;

        /** MediaMsg mediaId. */
        mediaId: string;

        /** MediaMsg key. */
        key: Uint8Array;

        /** MediaMsg iv. */
        iv: Uint8Array;

        /** MediaMsg mimeType. */
        mimeType: string;

        /** MediaMsg size. */
        size: number;

        /** MediaMsg fileName. */
        fileName: string;

        /** MediaMsg caption. */
        caption: string;

        /** MediaMsg width. */
        width: number;

        /** MediaMsg height. */
        height: number;

        /**
         * Creates a new MediaMsg instance using the specified properties.
         * @param [properties] Properties to set
         * @returns MediaMsg instance
         */
        static create(properties: canari.MediaMsg.$Shape): canari.MediaMsg & canari.MediaMsg.$Shape;
        static create(properties?: canari.MediaMsg.$Properties): canari.MediaMsg;

        /**
         * Encodes the specified MediaMsg message. Does not implicitly {@link canari.MediaMsg.verify|verify} messages.
         * @param message MediaMsg message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encode(message: canari.MediaMsg.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified MediaMsg message, length delimited. Does not implicitly {@link canari.MediaMsg.verify|verify} messages.
         * @param message MediaMsg message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encodeDelimited(message: canari.MediaMsg.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a MediaMsg message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns {canari.MediaMsg & canari.MediaMsg.$Shape} MediaMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): canari.MediaMsg & canari.MediaMsg.$Shape;

        /**
         * Decodes a MediaMsg message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns {canari.MediaMsg & canari.MediaMsg.$Shape} MediaMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): canari.MediaMsg & canari.MediaMsg.$Shape;

        /**
         * Verifies a MediaMsg message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a MediaMsg message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns MediaMsg
         */
        static fromObject(object: { [k: string]: any }): canari.MediaMsg;

        /**
         * Creates a plain object from a MediaMsg message. Also converts values to other types if specified.
         * @param message MediaMsg
         * @param [options] Conversion options
         * @returns Plain object
         */
        static toObject(message: canari.MediaMsg, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this MediaMsg to JSON.
         * @returns JSON object
         */
        toJSON(): { [k: string]: any };

        /**
         * Gets the type url for MediaMsg
         * @param [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns The type url
         */
        static getTypeUrl(prefix?: string): string;
    }

    namespace MediaMsg {

        /** Properties of a MediaMsg. */
        interface $Properties {

            /** MediaMsg kind */
            kind?: (canari.MediaKind|null);

            /** MediaMsg mediaId */
            mediaId?: (string|null);

            /** MediaMsg key */
            key?: (Uint8Array|null);

            /** MediaMsg iv */
            iv?: (Uint8Array|null);

            /** MediaMsg mimeType */
            mimeType?: (string|null);

            /** MediaMsg size */
            size?: (number|null);

            /** MediaMsg fileName */
            fileName?: (string|null);

            /** MediaMsg caption */
            caption?: (string|null);

            /** MediaMsg width */
            width?: (number|null);

            /** MediaMsg height */
            height?: (number|null);

            /** Unknown fields preserved while decoding */
            $unknowns?: Uint8Array[];
        }

        /** Shape of a MediaMsg. */
        type $Shape = canari.MediaMsg.$Properties;
    }

    /**
     * Properties of a SystemMsg.
     * @deprecated Use canari.SystemMsg.$Properties instead.
     */
    interface ISystemMsg extends canari.SystemMsg.$Properties {
    }

    /** Represents a SystemMsg. */
    class SystemMsg {

        /**
         * Constructs a new SystemMsg.
         * @param [properties] Properties to set
         */
        constructor(properties?: canari.SystemMsg.$Properties);

        /** Unknown fields preserved while decoding */
        $unknowns?: Uint8Array[];

        /** SystemMsg event. */
        event: string;

        /** SystemMsg data. */
        data: string;

        /**
         * Creates a new SystemMsg instance using the specified properties.
         * @param [properties] Properties to set
         * @returns SystemMsg instance
         */
        static create(properties: canari.SystemMsg.$Shape): canari.SystemMsg & canari.SystemMsg.$Shape;
        static create(properties?: canari.SystemMsg.$Properties): canari.SystemMsg;

        /**
         * Encodes the specified SystemMsg message. Does not implicitly {@link canari.SystemMsg.verify|verify} messages.
         * @param message SystemMsg message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encode(message: canari.SystemMsg.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified SystemMsg message, length delimited. Does not implicitly {@link canari.SystemMsg.verify|verify} messages.
         * @param message SystemMsg message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encodeDelimited(message: canari.SystemMsg.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a SystemMsg message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns {canari.SystemMsg & canari.SystemMsg.$Shape} SystemMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): canari.SystemMsg & canari.SystemMsg.$Shape;

        /**
         * Decodes a SystemMsg message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns {canari.SystemMsg & canari.SystemMsg.$Shape} SystemMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): canari.SystemMsg & canari.SystemMsg.$Shape;

        /**
         * Verifies a SystemMsg message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a SystemMsg message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns SystemMsg
         */
        static fromObject(object: { [k: string]: any }): canari.SystemMsg;

        /**
         * Creates a plain object from a SystemMsg message. Also converts values to other types if specified.
         * @param message SystemMsg
         * @param [options] Conversion options
         * @returns Plain object
         */
        static toObject(message: canari.SystemMsg, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this SystemMsg to JSON.
         * @returns JSON object
         */
        toJSON(): { [k: string]: any };

        /**
         * Gets the type url for SystemMsg
         * @param [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns The type url
         */
        static getTypeUrl(prefix?: string): string;
    }

    namespace SystemMsg {

        /** Properties of a SystemMsg. */
        interface $Properties {

            /** SystemMsg event */
            event?: (string|null);

            /** SystemMsg data */
            data?: (string|null);

            /** Unknown fields preserved while decoding */
            $unknowns?: Uint8Array[];
        }

        /** Shape of a SystemMsg. */
        type $Shape = canari.SystemMsg.$Properties;
    }
}
