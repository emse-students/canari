import * as $protobuf from "protobufjs";
import Long = require("long");
/** Namespace canari. */
export namespace canari {

    /** Properties of a WsEnvelope. */
    interface IWsEnvelope {

        /** WsEnvelope mls */
        mls?: (canari.IMlsFrame|null);

        /** WsEnvelope welcome */
        welcome?: (canari.IWelcomeFrame|null);

        /** WsEnvelope read */
        read?: (canari.IReadAck|null);
    }

    /** Represents a WsEnvelope. */
    class WsEnvelope implements IWsEnvelope {

        /**
         * Constructs a new WsEnvelope.
         * @param [properties] Properties to set
         */
        constructor(properties?: canari.IWsEnvelope);

        /** WsEnvelope mls. */
        public mls?: (canari.IMlsFrame|null);

        /** WsEnvelope welcome. */
        public welcome?: (canari.IWelcomeFrame|null);

        /** WsEnvelope read. */
        public read?: (canari.IReadAck|null);

        /** WsEnvelope body. */
        public body?: ("mls"|"welcome"|"read");

        /**
         * Creates a new WsEnvelope instance using the specified properties.
         * @param [properties] Properties to set
         * @returns WsEnvelope instance
         */
        public static create(properties?: canari.IWsEnvelope): canari.WsEnvelope;

        /**
         * Encodes the specified WsEnvelope message. Does not implicitly {@link canari.WsEnvelope.verify|verify} messages.
         * @param message WsEnvelope message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: canari.IWsEnvelope, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified WsEnvelope message, length delimited. Does not implicitly {@link canari.WsEnvelope.verify|verify} messages.
         * @param message WsEnvelope message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: canari.IWsEnvelope, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a WsEnvelope message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns WsEnvelope
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): canari.WsEnvelope;

        /**
         * Decodes a WsEnvelope message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns WsEnvelope
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): canari.WsEnvelope;

        /**
         * Verifies a WsEnvelope message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a WsEnvelope message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns WsEnvelope
         */
        public static fromObject(object: { [k: string]: any }): canari.WsEnvelope;

        /**
         * Creates a plain object from a WsEnvelope message. Also converts values to other types if specified.
         * @param message WsEnvelope
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: canari.WsEnvelope, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this WsEnvelope to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for WsEnvelope
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** Properties of a Recipient. */
    interface IRecipient {

        /** Recipient userId */
        userId?: (string|null);

        /** Recipient deviceId */
        deviceId?: (string|null);
    }

    /** Represents a Recipient. */
    class Recipient implements IRecipient {

        /**
         * Constructs a new Recipient.
         * @param [properties] Properties to set
         */
        constructor(properties?: canari.IRecipient);

        /** Recipient userId. */
        public userId: string;

        /** Recipient deviceId. */
        public deviceId: string;

        /**
         * Creates a new Recipient instance using the specified properties.
         * @param [properties] Properties to set
         * @returns Recipient instance
         */
        public static create(properties?: canari.IRecipient): canari.Recipient;

        /**
         * Encodes the specified Recipient message. Does not implicitly {@link canari.Recipient.verify|verify} messages.
         * @param message Recipient message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: canari.IRecipient, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified Recipient message, length delimited. Does not implicitly {@link canari.Recipient.verify|verify} messages.
         * @param message Recipient message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: canari.IRecipient, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a Recipient message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns Recipient
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): canari.Recipient;

        /**
         * Decodes a Recipient message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns Recipient
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): canari.Recipient;

        /**
         * Verifies a Recipient message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a Recipient message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns Recipient
         */
        public static fromObject(object: { [k: string]: any }): canari.Recipient;

        /**
         * Creates a plain object from a Recipient message. Also converts values to other types if specified.
         * @param message Recipient
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: canari.Recipient, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this Recipient to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for Recipient
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** Properties of a MlsFrame. */
    interface IMlsFrame {

        /** MlsFrame ciphertext */
        ciphertext?: (Uint8Array|null);

        /** MlsFrame groupId */
        groupId?: (string|null);

        /** MlsFrame recipients */
        recipients?: (canari.IRecipient[]|null);
    }

    /** Represents a MlsFrame. */
    class MlsFrame implements IMlsFrame {

        /**
         * Constructs a new MlsFrame.
         * @param [properties] Properties to set
         */
        constructor(properties?: canari.IMlsFrame);

        /** MlsFrame ciphertext. */
        public ciphertext: Uint8Array;

        /** MlsFrame groupId. */
        public groupId: string;

        /** MlsFrame recipients. */
        public recipients: canari.IRecipient[];

        /**
         * Creates a new MlsFrame instance using the specified properties.
         * @param [properties] Properties to set
         * @returns MlsFrame instance
         */
        public static create(properties?: canari.IMlsFrame): canari.MlsFrame;

        /**
         * Encodes the specified MlsFrame message. Does not implicitly {@link canari.MlsFrame.verify|verify} messages.
         * @param message MlsFrame message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: canari.IMlsFrame, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified MlsFrame message, length delimited. Does not implicitly {@link canari.MlsFrame.verify|verify} messages.
         * @param message MlsFrame message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: canari.IMlsFrame, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a MlsFrame message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns MlsFrame
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): canari.MlsFrame;

        /**
         * Decodes a MlsFrame message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns MlsFrame
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): canari.MlsFrame;

        /**
         * Verifies a MlsFrame message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a MlsFrame message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns MlsFrame
         */
        public static fromObject(object: { [k: string]: any }): canari.MlsFrame;

        /**
         * Creates a plain object from a MlsFrame message. Also converts values to other types if specified.
         * @param message MlsFrame
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: canari.MlsFrame, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this MlsFrame to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for MlsFrame
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** Properties of a WelcomeFrame. */
    interface IWelcomeFrame {

        /** WelcomeFrame ciphertext */
        ciphertext?: (Uint8Array|null);

        /** WelcomeFrame groupId */
        groupId?: (string|null);

        /** WelcomeFrame recipients */
        recipients?: (canari.IRecipient[]|null);
    }

    /** Represents a WelcomeFrame. */
    class WelcomeFrame implements IWelcomeFrame {

        /**
         * Constructs a new WelcomeFrame.
         * @param [properties] Properties to set
         */
        constructor(properties?: canari.IWelcomeFrame);

        /** WelcomeFrame ciphertext. */
        public ciphertext: Uint8Array;

        /** WelcomeFrame groupId. */
        public groupId: string;

        /** WelcomeFrame recipients. */
        public recipients: canari.IRecipient[];

        /**
         * Creates a new WelcomeFrame instance using the specified properties.
         * @param [properties] Properties to set
         * @returns WelcomeFrame instance
         */
        public static create(properties?: canari.IWelcomeFrame): canari.WelcomeFrame;

        /**
         * Encodes the specified WelcomeFrame message. Does not implicitly {@link canari.WelcomeFrame.verify|verify} messages.
         * @param message WelcomeFrame message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: canari.IWelcomeFrame, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified WelcomeFrame message, length delimited. Does not implicitly {@link canari.WelcomeFrame.verify|verify} messages.
         * @param message WelcomeFrame message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: canari.IWelcomeFrame, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a WelcomeFrame message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns WelcomeFrame
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): canari.WelcomeFrame;

        /**
         * Decodes a WelcomeFrame message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns WelcomeFrame
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): canari.WelcomeFrame;

        /**
         * Verifies a WelcomeFrame message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a WelcomeFrame message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns WelcomeFrame
         */
        public static fromObject(object: { [k: string]: any }): canari.WelcomeFrame;

        /**
         * Creates a plain object from a WelcomeFrame message. Also converts values to other types if specified.
         * @param message WelcomeFrame
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: canari.WelcomeFrame, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this WelcomeFrame to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for WelcomeFrame
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** Properties of a ReadAck. */
    interface IReadAck {

        /** ReadAck messageId */
        messageId?: (string|null);
    }

    /** Represents a ReadAck. */
    class ReadAck implements IReadAck {

        /**
         * Constructs a new ReadAck.
         * @param [properties] Properties to set
         */
        constructor(properties?: canari.IReadAck);

        /** ReadAck messageId. */
        public messageId: string;

        /**
         * Creates a new ReadAck instance using the specified properties.
         * @param [properties] Properties to set
         * @returns ReadAck instance
         */
        public static create(properties?: canari.IReadAck): canari.ReadAck;

        /**
         * Encodes the specified ReadAck message. Does not implicitly {@link canari.ReadAck.verify|verify} messages.
         * @param message ReadAck message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: canari.IReadAck, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified ReadAck message, length delimited. Does not implicitly {@link canari.ReadAck.verify|verify} messages.
         * @param message ReadAck message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: canari.IReadAck, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a ReadAck message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns ReadAck
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): canari.ReadAck;

        /**
         * Decodes a ReadAck message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns ReadAck
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): canari.ReadAck;

        /**
         * Verifies a ReadAck message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a ReadAck message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns ReadAck
         */
        public static fromObject(object: { [k: string]: any }): canari.ReadAck;

        /**
         * Creates a plain object from a ReadAck message. Also converts values to other types if specified.
         * @param message ReadAck
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: canari.ReadAck, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this ReadAck to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for ReadAck
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** Properties of an InboundMsg. */
    interface IInboundMsg {

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
    }

    /** Represents an InboundMsg. */
    class InboundMsg implements IInboundMsg {

        /**
         * Constructs a new InboundMsg.
         * @param [properties] Properties to set
         */
        constructor(properties?: canari.IInboundMsg);

        /** InboundMsg ciphertext. */
        public ciphertext: Uint8Array;

        /** InboundMsg senderId. */
        public senderId: string;

        /** InboundMsg senderDeviceId. */
        public senderDeviceId: string;

        /** InboundMsg groupId. */
        public groupId: string;

        /** InboundMsg isWelcome. */
        public isWelcome: boolean;

        /**
         * Creates a new InboundMsg instance using the specified properties.
         * @param [properties] Properties to set
         * @returns InboundMsg instance
         */
        public static create(properties?: canari.IInboundMsg): canari.InboundMsg;

        /**
         * Encodes the specified InboundMsg message. Does not implicitly {@link canari.InboundMsg.verify|verify} messages.
         * @param message InboundMsg message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: canari.IInboundMsg, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified InboundMsg message, length delimited. Does not implicitly {@link canari.InboundMsg.verify|verify} messages.
         * @param message InboundMsg message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: canari.IInboundMsg, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes an InboundMsg message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns InboundMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): canari.InboundMsg;

        /**
         * Decodes an InboundMsg message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns InboundMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): canari.InboundMsg;

        /**
         * Verifies an InboundMsg message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates an InboundMsg message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns InboundMsg
         */
        public static fromObject(object: { [k: string]: any }): canari.InboundMsg;

        /**
         * Creates a plain object from an InboundMsg message. Also converts values to other types if specified.
         * @param message InboundMsg
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: canari.InboundMsg, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this InboundMsg to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for InboundMsg
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** Properties of an AppMessage. */
    interface IAppMessage {

        /** AppMessage messageId */
        messageId?: (string|null);

        /** AppMessage text */
        text?: (canari.ITextMsg|null);

        /** AppMessage reply */
        reply?: (canari.IReplyMsg|null);

        /** AppMessage reaction */
        reaction?: (canari.IReactionMsg|null);

        /** AppMessage media */
        media?: (canari.IMediaMsg|null);

        /** AppMessage system */
        system?: (canari.ISystemMsg|null);

        /** AppMessage call */
        call?: (canari.ICallMsg|null);
    }

    /** Represents an AppMessage. */
    class AppMessage implements IAppMessage {

        /**
         * Constructs a new AppMessage.
         * @param [properties] Properties to set
         */
        constructor(properties?: canari.IAppMessage);

        /** AppMessage messageId. */
        public messageId: string;

        /** AppMessage text. */
        public text?: (canari.ITextMsg|null);

        /** AppMessage reply. */
        public reply?: (canari.IReplyMsg|null);

        /** AppMessage reaction. */
        public reaction?: (canari.IReactionMsg|null);

        /** AppMessage media. */
        public media?: (canari.IMediaMsg|null);

        /** AppMessage system. */
        public system?: (canari.ISystemMsg|null);

        /** AppMessage call. */
        public call?: (canari.ICallMsg|null);

        /** AppMessage kind. */
        public kind?: ("text"|"reply"|"reaction"|"media"|"system"|"call");

        /**
         * Creates a new AppMessage instance using the specified properties.
         * @param [properties] Properties to set
         * @returns AppMessage instance
         */
        public static create(properties?: canari.IAppMessage): canari.AppMessage;

        /**
         * Encodes the specified AppMessage message. Does not implicitly {@link canari.AppMessage.verify|verify} messages.
         * @param message AppMessage message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: canari.IAppMessage, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified AppMessage message, length delimited. Does not implicitly {@link canari.AppMessage.verify|verify} messages.
         * @param message AppMessage message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: canari.IAppMessage, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes an AppMessage message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns AppMessage
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): canari.AppMessage;

        /**
         * Decodes an AppMessage message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns AppMessage
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): canari.AppMessage;

        /**
         * Verifies an AppMessage message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates an AppMessage message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns AppMessage
         */
        public static fromObject(object: { [k: string]: any }): canari.AppMessage;

        /**
         * Creates a plain object from an AppMessage message. Also converts values to other types if specified.
         * @param message AppMessage
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: canari.AppMessage, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this AppMessage to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for AppMessage
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** Properties of a CallMsg. */
    interface ICallMsg {

        /** CallMsg callId */
        callId?: (string|null);

        /** CallMsg offerSdp */
        offerSdp?: (string|null);

        /** CallMsg answerSdp */
        answerSdp?: (string|null);

        /** CallMsg iceCandidate */
        iceCandidate?: (string|null);

        /** CallMsg hangup */
        hangup?: (boolean|null);
    }

    /** Represents a CallMsg. */
    class CallMsg implements ICallMsg {

        /**
         * Constructs a new CallMsg.
         * @param [properties] Properties to set
         */
        constructor(properties?: canari.ICallMsg);

        /** CallMsg callId. */
        public callId: string;

        /** CallMsg offerSdp. */
        public offerSdp?: (string|null);

        /** CallMsg answerSdp. */
        public answerSdp?: (string|null);

        /** CallMsg iceCandidate. */
        public iceCandidate?: (string|null);

        /** CallMsg hangup. */
        public hangup?: (boolean|null);

        /** CallMsg payload. */
        public payload?: ("offerSdp"|"answerSdp"|"iceCandidate"|"hangup");

        /**
         * Creates a new CallMsg instance using the specified properties.
         * @param [properties] Properties to set
         * @returns CallMsg instance
         */
        public static create(properties?: canari.ICallMsg): canari.CallMsg;

        /**
         * Encodes the specified CallMsg message. Does not implicitly {@link canari.CallMsg.verify|verify} messages.
         * @param message CallMsg message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: canari.ICallMsg, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified CallMsg message, length delimited. Does not implicitly {@link canari.CallMsg.verify|verify} messages.
         * @param message CallMsg message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: canari.ICallMsg, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a CallMsg message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns CallMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): canari.CallMsg;

        /**
         * Decodes a CallMsg message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns CallMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): canari.CallMsg;

        /**
         * Verifies a CallMsg message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a CallMsg message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns CallMsg
         */
        public static fromObject(object: { [k: string]: any }): canari.CallMsg;

        /**
         * Creates a plain object from a CallMsg message. Also converts values to other types if specified.
         * @param message CallMsg
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: canari.CallMsg, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this CallMsg to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for CallMsg
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** Properties of a TextMsg. */
    interface ITextMsg {

        /** TextMsg content */
        content?: (string|null);
    }

    /** Represents a TextMsg. */
    class TextMsg implements ITextMsg {

        /**
         * Constructs a new TextMsg.
         * @param [properties] Properties to set
         */
        constructor(properties?: canari.ITextMsg);

        /** TextMsg content. */
        public content: string;

        /**
         * Creates a new TextMsg instance using the specified properties.
         * @param [properties] Properties to set
         * @returns TextMsg instance
         */
        public static create(properties?: canari.ITextMsg): canari.TextMsg;

        /**
         * Encodes the specified TextMsg message. Does not implicitly {@link canari.TextMsg.verify|verify} messages.
         * @param message TextMsg message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: canari.ITextMsg, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified TextMsg message, length delimited. Does not implicitly {@link canari.TextMsg.verify|verify} messages.
         * @param message TextMsg message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: canari.ITextMsg, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a TextMsg message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns TextMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): canari.TextMsg;

        /**
         * Decodes a TextMsg message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns TextMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): canari.TextMsg;

        /**
         * Verifies a TextMsg message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a TextMsg message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns TextMsg
         */
        public static fromObject(object: { [k: string]: any }): canari.TextMsg;

        /**
         * Creates a plain object from a TextMsg message. Also converts values to other types if specified.
         * @param message TextMsg
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: canari.TextMsg, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this TextMsg to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for TextMsg
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** Properties of a ReplyRef. */
    interface IReplyRef {

        /** ReplyRef id */
        id?: (string|null);

        /** ReplyRef senderId */
        senderId?: (string|null);

        /** ReplyRef preview */
        preview?: (string|null);
    }

    /** Represents a ReplyRef. */
    class ReplyRef implements IReplyRef {

        /**
         * Constructs a new ReplyRef.
         * @param [properties] Properties to set
         */
        constructor(properties?: canari.IReplyRef);

        /** ReplyRef id. */
        public id: string;

        /** ReplyRef senderId. */
        public senderId: string;

        /** ReplyRef preview. */
        public preview: string;

        /**
         * Creates a new ReplyRef instance using the specified properties.
         * @param [properties] Properties to set
         * @returns ReplyRef instance
         */
        public static create(properties?: canari.IReplyRef): canari.ReplyRef;

        /**
         * Encodes the specified ReplyRef message. Does not implicitly {@link canari.ReplyRef.verify|verify} messages.
         * @param message ReplyRef message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: canari.IReplyRef, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified ReplyRef message, length delimited. Does not implicitly {@link canari.ReplyRef.verify|verify} messages.
         * @param message ReplyRef message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: canari.IReplyRef, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a ReplyRef message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns ReplyRef
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): canari.ReplyRef;

        /**
         * Decodes a ReplyRef message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns ReplyRef
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): canari.ReplyRef;

        /**
         * Verifies a ReplyRef message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a ReplyRef message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns ReplyRef
         */
        public static fromObject(object: { [k: string]: any }): canari.ReplyRef;

        /**
         * Creates a plain object from a ReplyRef message. Also converts values to other types if specified.
         * @param message ReplyRef
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: canari.ReplyRef, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this ReplyRef to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for ReplyRef
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** Properties of a ReplyMsg. */
    interface IReplyMsg {

        /** ReplyMsg content */
        content?: (string|null);

        /** ReplyMsg replyTo */
        replyTo?: (canari.IReplyRef|null);
    }

    /** Represents a ReplyMsg. */
    class ReplyMsg implements IReplyMsg {

        /**
         * Constructs a new ReplyMsg.
         * @param [properties] Properties to set
         */
        constructor(properties?: canari.IReplyMsg);

        /** ReplyMsg content. */
        public content: string;

        /** ReplyMsg replyTo. */
        public replyTo?: (canari.IReplyRef|null);

        /**
         * Creates a new ReplyMsg instance using the specified properties.
         * @param [properties] Properties to set
         * @returns ReplyMsg instance
         */
        public static create(properties?: canari.IReplyMsg): canari.ReplyMsg;

        /**
         * Encodes the specified ReplyMsg message. Does not implicitly {@link canari.ReplyMsg.verify|verify} messages.
         * @param message ReplyMsg message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: canari.IReplyMsg, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified ReplyMsg message, length delimited. Does not implicitly {@link canari.ReplyMsg.verify|verify} messages.
         * @param message ReplyMsg message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: canari.IReplyMsg, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a ReplyMsg message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns ReplyMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): canari.ReplyMsg;

        /**
         * Decodes a ReplyMsg message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns ReplyMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): canari.ReplyMsg;

        /**
         * Verifies a ReplyMsg message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a ReplyMsg message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns ReplyMsg
         */
        public static fromObject(object: { [k: string]: any }): canari.ReplyMsg;

        /**
         * Creates a plain object from a ReplyMsg message. Also converts values to other types if specified.
         * @param message ReplyMsg
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: canari.ReplyMsg, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this ReplyMsg to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for ReplyMsg
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** Properties of a ReactionMsg. */
    interface IReactionMsg {

        /** ReactionMsg messageId */
        messageId?: (string|null);

        /** ReactionMsg emoji */
        emoji?: (string|null);
    }

    /** Represents a ReactionMsg. */
    class ReactionMsg implements IReactionMsg {

        /**
         * Constructs a new ReactionMsg.
         * @param [properties] Properties to set
         */
        constructor(properties?: canari.IReactionMsg);

        /** ReactionMsg messageId. */
        public messageId: string;

        /** ReactionMsg emoji. */
        public emoji: string;

        /**
         * Creates a new ReactionMsg instance using the specified properties.
         * @param [properties] Properties to set
         * @returns ReactionMsg instance
         */
        public static create(properties?: canari.IReactionMsg): canari.ReactionMsg;

        /**
         * Encodes the specified ReactionMsg message. Does not implicitly {@link canari.ReactionMsg.verify|verify} messages.
         * @param message ReactionMsg message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: canari.IReactionMsg, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified ReactionMsg message, length delimited. Does not implicitly {@link canari.ReactionMsg.verify|verify} messages.
         * @param message ReactionMsg message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: canari.IReactionMsg, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a ReactionMsg message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns ReactionMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): canari.ReactionMsg;

        /**
         * Decodes a ReactionMsg message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns ReactionMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): canari.ReactionMsg;

        /**
         * Verifies a ReactionMsg message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a ReactionMsg message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns ReactionMsg
         */
        public static fromObject(object: { [k: string]: any }): canari.ReactionMsg;

        /**
         * Creates a plain object from a ReactionMsg message. Also converts values to other types if specified.
         * @param message ReactionMsg
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: canari.ReactionMsg, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this ReactionMsg to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for ReactionMsg
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** MediaKind enum. */
    enum MediaKind {
        MEDIA_FILE = 0,
        MEDIA_IMAGE = 1,
        MEDIA_VIDEO = 2,
        MEDIA_AUDIO = 3
    }

    /** Properties of a MediaMsg. */
    interface IMediaMsg {

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
    }

    /** Represents a MediaMsg. */
    class MediaMsg implements IMediaMsg {

        /**
         * Constructs a new MediaMsg.
         * @param [properties] Properties to set
         */
        constructor(properties?: canari.IMediaMsg);

        /** MediaMsg kind. */
        public kind: canari.MediaKind;

        /** MediaMsg mediaId. */
        public mediaId: string;

        /** MediaMsg key. */
        public key: Uint8Array;

        /** MediaMsg iv. */
        public iv: Uint8Array;

        /** MediaMsg mimeType. */
        public mimeType: string;

        /** MediaMsg size. */
        public size: number;

        /** MediaMsg fileName. */
        public fileName: string;

        /** MediaMsg caption. */
        public caption: string;

        /**
         * Creates a new MediaMsg instance using the specified properties.
         * @param [properties] Properties to set
         * @returns MediaMsg instance
         */
        public static create(properties?: canari.IMediaMsg): canari.MediaMsg;

        /**
         * Encodes the specified MediaMsg message. Does not implicitly {@link canari.MediaMsg.verify|verify} messages.
         * @param message MediaMsg message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: canari.IMediaMsg, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified MediaMsg message, length delimited. Does not implicitly {@link canari.MediaMsg.verify|verify} messages.
         * @param message MediaMsg message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: canari.IMediaMsg, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a MediaMsg message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns MediaMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): canari.MediaMsg;

        /**
         * Decodes a MediaMsg message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns MediaMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): canari.MediaMsg;

        /**
         * Verifies a MediaMsg message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a MediaMsg message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns MediaMsg
         */
        public static fromObject(object: { [k: string]: any }): canari.MediaMsg;

        /**
         * Creates a plain object from a MediaMsg message. Also converts values to other types if specified.
         * @param message MediaMsg
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: canari.MediaMsg, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this MediaMsg to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for MediaMsg
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** Properties of a SystemMsg. */
    interface ISystemMsg {

        /** SystemMsg event */
        event?: (string|null);

        /** SystemMsg data */
        data?: (string|null);
    }

    /** Represents a SystemMsg. */
    class SystemMsg implements ISystemMsg {

        /**
         * Constructs a new SystemMsg.
         * @param [properties] Properties to set
         */
        constructor(properties?: canari.ISystemMsg);

        /** SystemMsg event. */
        public event: string;

        /** SystemMsg data. */
        public data: string;

        /**
         * Creates a new SystemMsg instance using the specified properties.
         * @param [properties] Properties to set
         * @returns SystemMsg instance
         */
        public static create(properties?: canari.ISystemMsg): canari.SystemMsg;

        /**
         * Encodes the specified SystemMsg message. Does not implicitly {@link canari.SystemMsg.verify|verify} messages.
         * @param message SystemMsg message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: canari.ISystemMsg, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified SystemMsg message, length delimited. Does not implicitly {@link canari.SystemMsg.verify|verify} messages.
         * @param message SystemMsg message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: canari.ISystemMsg, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a SystemMsg message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns SystemMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): canari.SystemMsg;

        /**
         * Decodes a SystemMsg message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns SystemMsg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): canari.SystemMsg;

        /**
         * Verifies a SystemMsg message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a SystemMsg message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns SystemMsg
         */
        public static fromObject(object: { [k: string]: any }): canari.SystemMsg;

        /**
         * Creates a plain object from a SystemMsg message. Also converts values to other types if specified.
         * @param message SystemMsg
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: canari.SystemMsg, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this SystemMsg to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for SystemMsg
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }
}
