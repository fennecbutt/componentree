/**
 * @author Fennec Cooper
 * @email
 * @create date 2018-10-02 19:26:32
 * @modify date 2018-10-02 19:26:32
 * @desc [description]
*/

import glob from 'glob-promise';

export interface ComponentreeConfiguration {
    base?: string;
    debug?: boolean;
    errorHandler?: (e: any) => any;
}

export type Newable = new () => any;

export interface Component extends Newable {
    type?: string;
    service?: boolean;
    tags?: string[];
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

@service
export class Componentree {
    protected components: Map<string, ComponentContainer> = new Map([[Componentree.name, this.MakeComponentContainer(<Component>Componentree, __filename)]]);
    protected instances: any[] = [];
    protected services: Map<string, any> = new Map([[Componentree.name, this]]);

    constructor(private config: ComponentreeConfiguration = defaultConfiguration) {
        this.config = { ...defaultConfiguration, ...this.config };
        global.register = this.Register.bind(this);
        (async () => {
            // 1 Load files
            const filesLoaded = (await glob(`**/*.${this.config.base}.js`)).map(file => require(`${process.cwd()}/${file}`) && this.Log(`Loaded ${file}`)).length;
            // 2 Validate injections and inits (checks they exist, checks for circularity/codependence)
            if (filesLoaded === 0) this.Log('Loaded 0 files!');
            // 2 Instantiate services (ordered by inits)
            Array.from(this.components.values()).map(container => container.component.service && this.instances.push(this.Inject(container.component)));
            // 3 Initialise services
        })().catch(e => this.config.errorHandler instanceof Function ? this.config.errorHandler(e) : console.log(e.stack || e));
    }

    protected GenerateManifest() {
        return Array.from(this.components).map(component => 0)
    }

    protected Log(message: any, ...optionalParams: any[]) {
        if (this.config.debug) console.log.apply(undefined, arguments);
    }

    protected MakeComponentContainer(component: Component, source: String | null = null): ComponentContainer {
        return {
            component,
            source: source
        }
    }

    Register(component: { new(): any }, source: String | null = null) {
        this.components.set(component.name, this.MakeComponentContainer(<Component>component, source));
    }

    protected GetInjectionNames(t: Component) {
        const matches = t.toString().match(/constructor.*?\(([^)]*)\)/);
        if (matches && matches.length === 2) {
            return matches[1].replace(/\s/g, '').split(',').filter(n => n.length > 0);
        } else throw new Error(`Component is not a class: ${JSON.stringify(t)}`);
    }

    protected Inject<T>(t: Component): T {
        return Reflect.construct(t, this.GetInjectionNames(t).map(name => {
            /**
              * NOTE source tracking for components is implemented by the source property in
              * ComponentContainer, but I haven't thought of a good way of how to get it yet
              * since components autonomously register. For the moment the stack trace will suffice.
              */
            if (!this.components.has(name)) throw new Error(`Could not find component: ${name} in component ${t.name}`);
            if (this.components.get(name)!.component.service) {
                if (!this.services.get(name)) this.services.set(name, this.Inject(this.components.get(name)!.component));
                return this.services.get(name);
            } else {
                return this.Inject(this.components.get(name)!.component);
            }
        }));
    }

    protected SafelyGetComponent(name: string) {
        if (!this.components.has(name)) throw new Error(`Could not find component: ${name}`)
        return this.components.get(name)!.component;
    }

    public Get(name: string) {
        return this.SafelyGetComponent(name);
    }

    public GetInstance<T>(component: Component): T {
        return this.Inject(component);
    }

    public GetByTags(...tags: string[]) {
        return Array.from(this.components.values()).filter(container => container.component.tags && container.component.tags.length !== 0 && container.component.tags.every(tag => tags.indexOf(tag) !== -1));
    }

    public GetByInheritance(inherits: any, ...tags: string[]) {
        return Array.from(this.components.values()).filter(container => container.component.prototype instanceof inherits && (tags.length === 0 || container.component.tags && container.component.tags.every(tag => tags.indexOf(tag) !== -1))).map(container => container.component);
    }
}

// NOTE change all decorators to use a common metadata function, expose this to components to help them modify component metadata in a protected way
export function component(t: Component) {
    t.type = 'component'
    t.tags = [];
    global.register(t);
}

export function service(t: Component) {
    t.service = true;
}

export function tag(...tags: string[]) {
    return (t: Component) => {
        (t.tags || (t.tags = [])) && (t.tags = t.tags.concat(tags));
    }
}

// NOTE for init of component a that requires components b and c that init, b and c init promises must be resolved before a init is called (makes sense!)
// What about multiple inits on a component? Just arbitrary order I guess, if we want a specific order use 1 init and branch from there
// What about arguments to these fns? Call with none, I suppose
export function init(t: Component, key: string, desc: PropertyDescriptor) {
    // if(!t.service) throw new Error(`Component ${t.name} must be a service to use init`); // This doesn't seem great. Could we automatically make things that use init functions services?
    service(t);
    (t.inits || (t.inits = [])) && t.inits.push(key); // NOTE find a more elegant way of doing this
}

// For init, load order needs to be changed
// Load
// Check inits are all satisfied
// Instantiate services
// Resolve init chains

// What about inits not being used on services? Ie not during startup. Services are restricted to singletones at the moment, what if we wanted
// To use init on a non-singleton component