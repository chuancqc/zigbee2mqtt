
import * as settings from '../util/settings';
// @ts-ignore
import zhc from 'zigbee-herdsman-converters';
import logger from '../util/logger';
import * as utils from '../util/utils';
import ExtensionTS from './extensionts';
// @ts-ignore
import stringify from 'json-stable-stringify-without-jsonify';
import Group from '../model/group';
import Device from '../model/device';

const topicRegex = new RegExp(`^(.+?)(?:/(${utils.endpointNames.join('|')}))?/(get|set)(?:/(.+))?`);
const propertyEndpointRegex = new RegExp(`^(.*)_(${utils.endpointNames.join('|')})$`);
const stateValues = ['on', 'off', 'toggle', 'open', 'close', 'stop', 'lock', 'unlock'];

// Legacy: don't provide default converters anymore, this is required by older z2m installs not saving group members
const defaultGroupConverters = [
    zhc.toZigbeeConverters.light_onoff_brightness,
    zhc.toZigbeeConverters.light_color_colortemp,
    zhc.toZigbeeConverters.effect,
    zhc.toZigbeeConverters.ignore_transition,
    zhc.toZigbeeConverters.cover_position_tilt,
    zhc.toZigbeeConverters.thermostat_occupied_heating_setpoint,
    zhc.toZigbeeConverters.tint_scene,
    zhc.toZigbeeConverters.light_brightness_move,
    zhc.toZigbeeConverters.light_brightness_step,
    zhc.toZigbeeConverters.light_colortemp_step,
    zhc.toZigbeeConverters.light_colortemp_move,
    zhc.toZigbeeConverters.light_hue_saturation_move,
    zhc.toZigbeeConverters.light_hue_saturation_step,
];

interface ParsedTopic {ID: string, endpoint: string, attribute: string, type: 'get' | 'set'}

class Publish extends ExtensionTS {
    start(): void {
        this.onMQTTMessage_ = this.onMQTTMessage_.bind(this);
        this.eventBus.onMQTTMessage(this, this.onMQTTMessage_);
    }

    parseTopic(topic: string): ParsedTopic | null {
        const match = topic.match(topicRegex);
        if (!match) {
            return null;
        }

        const ID = match[1].replace(`${settings.get().mqtt.base_topic}/`, '');
        // If we didn't replace base_topic we received something we don't care about
        if (ID === match[1] || ID.match(/bridge/)) {
            return null;
        }

        return {ID: ID, endpoint: match[2], type: match[3] as 'get' | 'set', attribute: match[4]};
    }

    parseMessage(parsedTopic: ParsedTopic, data: EventMQTTMessage): KeyValue | null {
        if (parsedTopic.attribute) {
            try {
                return {[parsedTopic.attribute]: JSON.parse(data.message)};
            } catch (e) {
                return {[parsedTopic.attribute]: data.message};
            }
        } else {
            try {
                return JSON.parse(data.message);
            } catch (e) {
                if (stateValues.includes(data.message.toLowerCase())) {
                    return {state: data.message};
                } else {
                    return null;
                }
            }
        }
    }

    legacyLog(payload: KeyValue): void {
        /* istanbul ignore else */
        if (settings.get().advanced.legacy_api) {
            this.mqtt.publish('bridge/log', stringify(payload));
        }
    }

    legacyRetrieveState(re: Device | Group, converter: ToZigbeeConverter, result: ToZigbeeConverterResult,
        target: ZHEndpoint | ZHGroup, key: string, meta: ToZigbeeConverterGetMeta): void {
        // It's possible for devices to get out of sync when writing an attribute that's not reportable.
        // So here we re-read the value after a specified timeout, this timeout could for example be the
        // transition time of a color change or for forcing a state read for devices that don't
        // automatically report a new state when set.
        // When reporting is requested for a device (report: true in device-specific settings) we won't
        // ever issue a read here, as we assume the device will properly report changes.
        // Only do this when the retrieve_state option is enabled for this device.
        // retrieve_state == decprecated
        if (re instanceof Device && result && result.hasOwnProperty('readAfterWriteTime') &&
            re.settings.retrieve_state
        ) {
            setTimeout(() => converter.convertGet(target, key, meta), result.readAfterWriteTime);
        }
    }

    updateMessageHomeAssistant(message: KeyValue, entityState: KeyValue): void {
        /**
         * Home Assistant always publishes 'state', even when e.g. only setting
         * the color temperature. This would lead to 2 zigbee publishes, where the first one
         * (state) is probably unecessary.
         */
        if (settings.get().homeassistant) {
            const hasColorTemp = message.hasOwnProperty('color_temp');
            const hasColor = message.hasOwnProperty('color');
            const hasBrightness = message.hasOwnProperty('brightness');
            const isOn = entityState.state === 'ON' ? true : false;
            if (isOn && (hasColorTemp || hasColor) && !hasBrightness) {
                delete message.state;
                logger.debug('Skipping state because of Home Assistant');
            }
        }
    }

    // TODO remove trailing _
    async onMQTTMessage_(data: EventMQTTMessage): Promise<void> {
        const parsedTopic = this.parseTopic(data.topic);
        if (!parsedTopic) return;

        const re = this.zigbee.resolveEntity(parsedTopic.ID);
        if (re == null) {
            this.legacyLog({type: `entity_not_found`, message: {friendly_name: parsedTopic.ID}});
            logger.error(`Entity '${parsedTopic.ID}' is unknown`);
            return;
        }

        // Get entity details
        const definition = re instanceof Device ? re.definition : re.membersDefinitions();
        if (definition == null) {
            logger.error(`Cannot publish to unsupported device '${re.name}'`);
            return;
        }
        const target = re instanceof Group ? re.zhGroup : re.endpoint(parsedTopic.endpoint);
        if (target == null) {
            logger.error(`Device '${re.name}' has no endpoint '${parsedTopic.endpoint}'`);
            return;
        }
        const device = re instanceof Device ? re.zhDevice : null;
        const entitySettings = re.settings;
        const entityState = this.state.get(re.ID) || {};
        const membersState = re instanceof Group ?
            Object.fromEntries(re.membersIeeeAddr().map((e) => [e, this.state.get(e)])) : null;
        let converters: ToZigbeeConverter[];
        {
            if (Array.isArray(definition)) {
                const c = new Set(definition.map((d) => d.toZigbee).flat());
                if (c.size == 0) converters = defaultGroupConverters;
                else converters = Array.from(c);
            } else {
                converters = definition.toZigbee;
            }
        }

        // Convert the MQTT message to a Zigbee message.
        const message = this.parseMessage(parsedTopic, data);
        if (message == null) {
            logger.error(`Invalid message '${message}', skipping...`);
            return;
        }
        this.updateMessageHomeAssistant(message, entityState);

        /**
         * Order state & brightness based on current bulb state
         *
         * Not all bulbs support setting the color/color_temp while it is off
         * this results in inconsistant behavior between different vendors.
         *
         * bulb on => move state & brightness to the back
         * bulb off => move state & brightness to the front
         */
        const entries = Object.entries(message);
        const sorter = typeof message.state === 'string' && message.state.toLowerCase() === 'off' ? 1 : -1;
        entries.sort((a) => (['state', 'brightness', 'brightness_percent'].includes(a[0]) ? sorter : sorter * -1));

        // For each attribute call the corresponding converter
        const usedConverters: {[s: number]: ToZigbeeConverter[]} = {};
        const toPublish: {[s: number | string]: KeyValue} = {};
        const addToToPublish = (ID: number | string, payload: KeyValue): void => {
            if (!(ID in toPublish)) toPublish[ID] = {};
            toPublish[ID] = {...toPublish[ID], ...payload};
        };

        for (let [key, value] of entries) {
            let endpointName = parsedTopic.endpoint;
            let localTarget = target;
            // @ts-ignore TODO fix
            let endpointOrGroupID = target.constructor.name === 'Endpoint' ? target.ID : target.groupID;

            // When the key has a endpointName included (e.g. state_right), this will override the target.
            const propertyEndpointMatch = key.match(propertyEndpointRegex);
            if (re instanceof Device && propertyEndpointMatch) {
                endpointName = propertyEndpointMatch[2];
                key = propertyEndpointMatch[1];
                localTarget = re.endpoint(endpointName);
                if (localTarget == null) {
                    logger.error(`Device '${re.name}' has no endpoint '${endpointName}'`);
                    continue;
                }
                endpointOrGroupID = localTarget.ID;
            }

            if (!usedConverters.hasOwnProperty(endpointOrGroupID)) usedConverters[endpointOrGroupID] = [];
            const converter = converters.find((c) => c.key.includes(key));

            if (parsedTopic.type === 'set' && usedConverters[endpointOrGroupID].includes(converter)) {
                // Use a converter for set only once
                // (e.g. light_onoff_brightness converters can convert state and brightness)
                continue;
            }

            if (!converter) {
                logger.error(`No converter available for '${key}' (${message[key]})`);
                continue;
            }

            // Converter didn't return a result, skip
            const meta = {endpoint_name: endpointName, options: entitySettings, message: {...message}, logger, device,
                state: entityState, membersState, mapped: definition};

            // Strip endpoint name from meta.message properties.
            if (endpointName) {
                for (const [key, value] of Object.entries(meta.message)) {
                    if (key.endsWith(endpointName)) {
                        delete meta.message[key];
                        const keyWithoutEndpoint = key.substring(0, key.length - endpointName.length - 1);
                        meta.message[keyWithoutEndpoint] = value;
                    }
                }
            }

            try {
                if (parsedTopic.type === 'set' && converter.convertSet) {
                    logger.debug(`Publishing '${parsedTopic.type}' '${key}' to '${re.name}'`);
                    const result = await converter.convertSet(localTarget, key, value, meta);
                    const optimistic = !entitySettings.hasOwnProperty('optimistic') || entitySettings.optimistic;
                    if (result && result.state && optimistic) {
                        const msg = result.state;

                        if (endpointName) {
                            for (const key of Object.keys(msg)) {
                                msg[`${key}_${endpointName}`] = msg[key];
                                delete msg[key];
                            }
                        }

                        // filter out attribute listed in filtered_optimistic
                        entitySettings.filtered_optimistic?.forEach((a) => delete msg[a]);
                        addToToPublish(re.ID, msg);
                    }

                    if (result && result.membersState && optimistic) {
                        for (const [ieeeAddr, state] of Object.entries(result.membersState)) {
                            addToToPublish(ieeeAddr, state);
                        }
                    }

                    this.legacyRetrieveState(re, converter, result, localTarget, key, meta);
                } else if (parsedTopic.type === 'get' && converter.convertGet) {
                    logger.debug(`Publishing get '${parsedTopic.type}' '${key}' to '${re.name}'`);
                    await converter.convertGet(localTarget, key, meta);
                } else {
                    logger.error(`No converter available for '${parsedTopic.type}' '${key}' (${message[key]})`);
                    continue;
                }
            } catch (error) {
                const message =
                    `Publish '${parsedTopic.type}' '${key}' to '${re.name}' failed: '${error}'`;
                logger.error(message);
                logger.debug(error.stack);
                this.legacyLog({type: `zigbee_publish_error`, message, meta: {friendly_name: re.name}});
            }

            usedConverters[endpointOrGroupID].push(converter);
        }

        for (const [ID, payload] of Object.entries(toPublish)) {
            if (Object.keys(payload).length != 0) {
                this.publishEntityState(ID, payload);
            }
        }
    }
}

// TODO_finished: : change class to export default
module.exports = Publish;