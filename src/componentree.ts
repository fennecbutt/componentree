/**
 * @author Fennec Cooper
 * @email
 * @create date 2018-10-02 19:26:32
 * @modify date 2018-10-02 19:26:32
 * @desc [description]
*/

import glob from 'glob-promise';
import { map as mapAsync } from 'bluebird';

export interface ComponentreeConfiguration {
    base?: string;
    debug?: boolean;
    errorHandler?: (e: any) => any;
}

export type Newable<T> = new (...args: any[]) => T;

export interface Component<T = any> extends Newable<T> {
    [key: string]: any;
    type?: string;
    service?: boolean;
    tags?: Set<string>;
    noinjects?: (string | symbol)[];
    initialisers?: string[];
}

export interface InternalComponentInstance {
    inits?: string[];
}

export interface ComponentContainer {
    component: Component;
    source: String | null;
}

// NOTE do we always want to search fs for components or do we want to use a manifest system, or both?
// Could we search fs to load and build a manifest in dev and then use that manifest in prod? Probably a good idea
const defaultConfiguration = {
    base: 'c' // NOTE force base of c or override with componentree.json?
}

global.register = (component: Component) => (global.earlyComponents || (global.earlyComponents = [])) && global.earlyComponents.push(component);

@service
export class Componentree {
    protected components: Map<string, ComponentContainer> = new Map([[Componentree.name, this.MakeComponentContainer(<Component>Componentree, __filename)]]);
    protected instances: any[] = [];
    protected services: Map<string, any> = new Map([[Componentree.name, this]]);

    constructor(@noinject private config: ComponentreeConfiguration = defaultConfiguration) {
        this.config = { ...defaultConfiguration, ...this.config };
        global.register = this.Register.bind(this);
        global.earlyComponents = global.earlyComponents.filter(component => this.Register(component));
        (async () => {
            // 1 Load files
            const filesLoaded = (await glob(`**/*.${this.config.base}.js`)).map(file => require(`${process.cwd()}/${file}`) && this.Log(`Loaded ${file}`)).length;
            // 2 Validate injections and inits (checks they exist, checks for circularity/codependence)
            if (filesLoaded === 0) this.Log('Loaded 0 files!');
            // 2 Instantiate services (ordered by inits)
            await mapAsync(Array.from(this.components.values()).filter(container => container.component.service), async container => {
                if (!this.services.has(container.component.name)) {
                    console.log(`Starting service ${container.component.name}`);
                    this.services.set(container.component.name, await this.Inject(container.component));
                    console.log(`Started service ${container.component.name}`);
                }
            });
            // 3 Initialise services
        })().catch(e => this.config.errorHandler instanceof Function ? this.config.errorHandler(e) : console.log(e.stack || e));
    }
    // TODO default params break injection, componentree loops and keeps instantiating itself
    // protected GenerateManifest() {
    //     return Array.from(this.components).map(component => 0);
    // }

    protected Log(message: any, ...optionalParams: any[]) {
        if (this.config.debug) console.log(...arguments);
    }

    protected MakeComponentContainer(component: Component, source: String | null = null): ComponentContainer {
        return {
            component,
            source: source
        }
    }

    Register(component: Component, source: String | null = null) {
        this.components.set(component.name, this.MakeComponentContainer(<Component>component, source));
    }

    protected GetInjectionNames(t: Component) {
        // NOTE once the reflection stuff is working properly, we can switch to stringifying the constructor as a fallback
        const stringified = t.toString();
        if (stringified.indexOf(`class ${t.name}`) !== 0) throw new Error(`Component is not a class: ${JSON.stringify(t)}`);
        const matches = stringified.match(/constructor.*?\(([^)]*)\)/);
        if (matches && matches.length === 2) {
            return matches[1].replace(/\s/g, '').split(',').filter(n => (!t.noinjects || t.noinjects.indexOf(n) === -1) && n.length > 0); // NOTE change indexof here to includes once TS plays nice again
        } else return [];
    }

    protected async Inject<T>(t: Component): Promise<T> {
        const instance = Reflect.construct(t, await mapAsync(this.GetInjectionNames(t), async name => {
            /**
              * NOTE source tracking for components is implemented by the source property in
              * ComponentContainer, but I haven't thought of a good way of how to get it yet
              * since components autonomously register. For the moment the stack trace will suffice.
              */
            if (!this.components.has(name)) throw new Error(`Could not find component: ${name} in component ${t.name}`);
            if (this.components.get(name)!.component.service) {
                if (!this.services.get(name)) this.services.set(name, await this.Inject(this.components.get(name)!.component));
                return this.services.get(name);
            } else {
                return await this.Inject(this.components.get(name)!.component);
            }
        }));
        if (t.initialisers) {
            this.Log(`Initialising ${t.name}`);
            await Promise.all(t.initialisers.map(initialiser => instance[initialiser]()));
            this.Log(`${t.name} initialised`);
        }
        return instance;
    }

    protected SafelyGetComponent(name: string) {
        if (!this.components.has(name)) throw new Error(`Could not find component: ${name}`)
        return this.components.get(name)!.component;
    }

    public Get(name: string) {
        return this.SafelyGetComponent(name);
    }

    public GetInstance<T>(component: Component): Promise<T> {
        return this.Inject<T>(component);
    }

    public GetByTags(...tags: string[]) {
        return Array.from(this.components.values()).filter(container => container.component.tags && container.component.tags.size !== 0 && tags.every(tag => container.component.tags!.has(tag)));
    }

    public GetByInheritance<T>(inherits: any, ...tags: string[]) {
        return <T[]><unknown>Array.from(this.components.values()).filter(container => container.component.prototype instanceof inherits && (tags.length === 0 || container.component.tags && tags.every(tag => container.component.tags!.has(tag)))).map(container => container.component);
    }
}

// NOTE change all decorators to use a common metadata function, expose this to components to help them modify component metadata in a protected way
export function component(t: Component) {
    t.type = 'component'
    global.register(t);
}

export function service(t: Component) {
    if (t.type !== 'component') component(t); // NOTE component here should be a string enum! (Or a string literal)
    t.service = true;
}

export function tag(...tags: string[]) {
    return (t: Component) => {
        (t.tags || (t.tags = new Set())) && (tags.forEach(tag => t.tags!.add(tag)));
    }
}

// NOTE for init of component a that requires components b and c that init, b and c init promises must be resolved before a init is called (makes sense!)
// What about multiple inits on a component? Just arbitrary order I guess, if we want a specific order use 1 init and branch from there
// What about arguments to these fns? Call with none, I suppose
export function initialiser(t: any, key: string, desc: PropertyDescriptor) { // NOTE figure out the specific type of a prototype (without forcing prototype constructor's type to Function...) so that we can ensure that this decorator is only used on async methods!
    // if(!t.service) throw new Error(`Component ${t.name} must be a service to use init`); // This doesn't seem great. Could we automatically make things that use init functions services?
    // service(t); // NOTE need a way to get access to this here. Need to detect problems as much as possible.
    // (t.inits || (t.inits = [])) && t.inits.push(key); // NOTE find a more elegant way of doing this
    // console.log(` keys ${t.constructor} lol ${t.abc} k ${key} desc ${JSON.stringify(desc)}`);
    (t.constructor.initialisers || (t.constructor.initialisers = [])) && t.constructor.initialisers.push(key);
}

export function noinject(t: Component, key: string | symbol, index: number) {
    (t.noinjects || (t.noinjects = [])) && t.noinjects.push(key);
}

// For init, load order needs to be changed
// Load
// Check inits are all satisfied
// Instantiate services
// Resolve init chains

// What about inits not being used on services? Ie not during startup. Services are restricted to singletones at the moment, what if we wanted
// To use init on a non-singleton component