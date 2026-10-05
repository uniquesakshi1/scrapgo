import './style.css';
import { supabase } from './supabase';

interface ScrapItem {
  id?: string;
  name: string;
  rate: number;
  icon: string;
}

interface SelectedItem {
  name: string;
  weight: number;
  rate: number;
  actual_weight?: number;
}

interface Booking {
  id?: string;
  booking_code: string;
  customer_id?: string;
  pickup_boy_id?: string;
  buyer_id?: string;
  customer_name: string;
  customer_phone: string;
  customer_address: string;
  landmark?: string;
  latitude?: number;
  longitude?: number;
  shop_name?: string;
  pickup_date?: string;
  pickup_time?: string;
  items: SelectedItem[];
  estimated_amount: number;
  pickup_charge: number;
  actual_amount?: number;
  commission_amount?: number;
  payable_amount?: number;
  status: string;
  created_at?: string;
  scrap_photo_url?: string;
}

interface UserProfile {
  id: string;
  full_name: string;
  phone: string;
  address?: string;
  role: string;
}

let currentUser: any = null;
let currentProfile: UserProfile | null = null;
let selectedAuthRole: 'customer' | 'pickup_boy' | 'buyer' | 'admin' = 'customer';
let currentPickupBoyTab: 'assigned' | 'available' = 'assigned';
let currentBuyerTab: 'requests' | 'collected' = 'requests';
let currentViewName: 'home' | 'orders' | 'calculator' | 'auth' | 'admin' | 'pickup_boy' | 'buyer' = 'home';

let scrapCategories: ScrapItem[] = [
  { name: 'Kagaz / Paper', rate: 15, icon: '📰' },
  { name: 'Plastic', rate: 12, icon: '🍾' },
  { name: 'Loha / Metal', rate: 28, icon: '⚙' },
  { name: 'E-Waste', rate: 35, icon: '💻' }
];

let selectedItems: SelectedItem[] = [];

const app = document.querySelector('#app')!;

const isUuid = (value?: string): boolean =>
  !!value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

async function initApp() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.user) {
    currentUser = session.user;
    await fetchUserProfile(session.user.id);
  }

  supabase.auth.onAuthStateChange(async (_event, session) => {
    currentUser = session?.user || null;
    if (session?.user) {
      await fetchUserProfile(session.user.id);
    } else {
      currentProfile = null;
    }
    renderAppView();
  });

  await loadCategories();
  renderAppView();
}

function renderAppView() {
  if (!currentUser || !currentProfile) {
    if (currentViewName === 'orders') {
      renderOrders();
    } else {
      renderHome();
    }
    return;
  }

  switch (currentProfile.role) {
    case 'pickup_boy':
      currentViewName = 'pickup_boy';
      renderPickupBoyDashboard();
      break;
    case 'buyer':
      currentViewName = 'buyer';
      renderBuyerDashboard();
      break;
    case 'admin':
      currentViewName = 'admin';
      renderAdminDashboard();
      break;
    case 'customer':
    default:
      if (currentViewName === 'orders') {
        renderOrders();
      } else {
        renderHome();
      }
      break;
  }
}

function formatDateTime(isoString?: string): string {
  if (!isoString) return new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  try {
    return new Date(isoString).toLocaleString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  } catch (e) {
    return isoString;
  }
}

function calculateActualAmount(items: SelectedItem[]): number {
  if (!items || !Array.isArray(items)) return 0;
  return items.reduce((total, item) => {
    const weight = typeof item.actual_weight === 'number' && !isNaN(item.actual_weight) ? item.actual_weight : 0;
    return total + (weight * (item.rate || 0));
  }, 0);
}

function getCurrentLocation(): Promise<{ latitude: number; longitude: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation is not supported by your browser.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude
        });
      },
      (error) => {
        reject(error);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

async function uploadScrapPhoto(file: File, bookingCode: string): Promise<string | null> {
  try {
    const fileExt = file.name.split('.').pop() || 'jpg';
    const fileName = `${bookingCode}_${Date.now()}.${fileExt}`;
    const filePath = `scrap_photos/${fileName}`;

    const { error: uploadError } = await supabase.storage
      .from('scrap-photos')
      .upload(filePath, file, {
        cacheControl: '3600',
        upsert: true
      });

    if (uploadError) {
      console.warn('Supabase storage upload fallback to DataURL:', uploadError.message);
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      });
    }

    const { data: publicUrlData } = supabase.storage
      .from('scrap-photos')
      .getPublicUrl(filePath);

    return publicUrlData.publicUrl;
  } catch (err) {
    console.warn('Photo upload fallback to DataURL:', err);
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }
}

function renderStatusTimeline(currentStatus: string): string {
  if (currentStatus === 'Cancelled') {
    return `<div style="margin-top: 14px; padding: 10px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; color: #dc2626; font-size: 13px; font-weight: 600; text-align: center;"> ❌ Booking Cancelled </div>`;
  }

  const stages = [
    { key: 'Pending Buyer Review', label: 'Buyer Review', icon: '🏪' },
    { key: 'Pending Pickup', label: 'Picker Req.', icon: '⏳' },
    { key: 'Assigned', label: 'Assigned', icon: '🛵' },
    { key: 'Collected', label: 'Collected', icon: '📦' },
    { key: 'Completed', label: 'Completed', icon: '🎉' }
  ];

  const stageOrder = ['Pending Buyer Review', 'Pending Pickup', 'Assigned', 'Collected', 'Completed'];
  let currentIndex = stageOrder.indexOf(currentStatus);
  if (currentIndex === -1) currentIndex = 0;

  const progressPercent = currentIndex <= 0 ? 0 : (currentIndex / (stages.length - 1)) * 100;

  return `
  <div style="margin-top: 15px; padding-top: 12px; border-top: 1px solid #e5e7eb;">
    <div style="font-size: 11px; font-weight: 700; color: #6b7280; text-transform: uppercase; margin-bottom: 10px;">Tracking Status</div>
    <div style="position: relative; margin: 10px 0 5px 0;">
      <div style="position: absolute; top: 14px; left: 10%; right: 10%; height: 3px; background: #e5e7eb; z-index: 1;"></div>
      <div style="position: absolute; top: 14px; left: 10%; width: calc(${progressPercent}% * 0.8); height: 3px; background: #16a34a; z-index: 2; transition: width 0.3s ease;"></div>
      <div style="display: flex; justify-content: space-between; align-items: flex-start; position: relative; z-index: 3;">
        ${stages.map((stage, idx) => {
          const isDone = currentIndex > idx;
          const isCurrent = currentIndex === idx;
          let circleBg = '#ffffff';
          let circleBorder = '#d1d5db';
          let circleColor = '#6b7280';
          let labelColor = '#9ca3af';
          let fontWeight = '500';

          if (isDone) {
            circleBg = '#16a34a';
            circleBorder = '#16a34a';
            circleColor = '#ffffff';
            labelColor = '#16a34a';
            fontWeight = '600';
          } else if (isCurrent) {
            circleBg = '#16a34a';
            circleBorder = '#15803d';
            circleColor = '#ffffff';
            labelColor = '#15803d';
            fontWeight = '700';
          }

          return `<div style="display: flex; flex-direction: column; align-items: center; width: 18%;"> 
            <div style="width: 28px; height: 28px; border-radius: 50%; background: ${circleBg}; border: 2px solid ${circleBorder}; color: ${circleColor}; display: flex; align-items: center; justify-content: center; font-size: 11px; box-shadow: ${isCurrent ? '0 0 0 3px #dcfce7' : 'none'}; transition: all 0.2s ease;"> 
              ${isDone ? '✓' : stage.icon} 
            </div> 
            <span style="font-size: 9px; margin-top: 6px; text-align: center; color: ${labelColor}; font-weight: ${fontWeight}; line-height: 1.1;"> ${stage.label} </span> 
          </div>`;
        }).join('')}
      </div>
    </div>
  </div>
  `;
}

async function fetchUserProfile(userId: string) {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (!error && data) {
      currentProfile = data as UserProfile;
    }
  } catch (err) {
    console.error('Error fetching profile:', err);
  }
}

async function handleSignUpWithRole(email: string, pass: string, fullName: string, phone: string, address: string, role: string) {
  try {
    const { error } = await supabase.auth.signUp({
      email,
      password: pass,
      options: {
        data: {
          full_name: fullName,
          phone: phone,
          address: address,
          role: role
        }
      }
    });

    if (error) throw error;
    alert(`Account successfully created as ${role.toUpperCase()}!`);
    renderAppView();
  } catch (err: any) {
    alert(err.message || 'Signup failed.');
  }
}

async function handleLogin(email: string, pass: string) {
  try {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password: pass
    });

    if (error) throw error;
    renderAppView();
  } catch (err: any) {
    alert(err.message || 'Login failed.');
  }
}

async function handleLogout() {
  await supabase.auth.signOut();
  currentUser = null;
  currentProfile = null;
  currentViewName = 'home';
  renderAppView();
}

async function loadCategories() {
  try {
    const { data, error } = await supabase.from('scrap_categories').select('*');
    if (!error && data && data.length > 0) {
      scrapCategories = data.map(item => ({
        id: item.id,
        name: item.name,
        rate: Number(item.rate_per_kg),
        icon: item.icon || '📦'
      }));
    }
  } catch (err) {
    console.warn('Using default categories');
  }
}

function saveBookingToLocalStorage(booking: Booking): Booking {
  const existingBookings: Booking[] = JSON.parse(localStorage.getItem('scrapgo_bookings') || '[]');
  const isExists = existingBookings.some(b => b.booking_code === booking.booking_code);
  if (!isExists) {
    existingBookings.unshift(booking);
    localStorage.setItem('scrapgo_bookings', JSON.stringify(existingBookings));
  } else {
    const index = existingBookings.findIndex(b => b.booking_code === booking.booking_code || (b.id && b.id === booking.id));
    if (index !== -1) {
      existingBookings[index] = { ...existingBookings[index], ...booking };
      localStorage.setItem('scrapgo_bookings', JSON.stringify(existingBookings));
    }
  }
  return booking;
}

// FIXED: Robust Deletion Logic for both Supabase DB and LocalStorage
async function deleteBooking(bookingId?: string, bookingCode?: string, isFromCustomerOrders: boolean = false): Promise<void> {
  if (!confirm('Kya aap sachme is order ko delete krna chahte hain?')) return;

  try {
    let dbSuccess = false;
    let dbErrorMsg = '';

    // Step 1: Try delete by UUID ID if valid
    if (bookingId && isUuid(bookingId)) {
      const { error } = await supabase
        .from('bookings')
        .delete()
        .eq('id', bookingId);

      if (error) {
        console.error('Supabase deletion error by ID:', error);
        dbErrorMsg = error.message;
      } else {
        dbSuccess = true;
      }
    }

    // Step 2: Fallback delete by booking_code if ID delete failed or wasn't UUID
    if (!dbSuccess && bookingCode) {
      const { error: codeError } = await supabase
        .from('bookings')
        .delete()
        .eq('booking_code', bookingCode);

      if (codeError) {
        console.error('Supabase deletion error by booking_code:', codeError);
        if (!dbErrorMsg) dbErrorMsg = codeError.message;
      } else {
        dbSuccess = true;
      }
    }

    // Step 3: Always remove from local storage
    let localOrders: Booking[] = JSON.parse(localStorage.getItem('scrapgo_bookings') || '[]');
    localOrders = localOrders.filter(b => b.id !== bookingId && b.booking_code !== bookingCode);
    localStorage.setItem('scrapgo_bookings', JSON.stringify(localOrders));

    if (dbSuccess || !dbErrorMsg) {
      alert('Order successfully deleted!');
    } else {
      alert(`Local order removed! Note (DB Warning): ${dbErrorMsg}`);
    }

    if (isFromCustomerOrders || currentViewName === 'orders') {
      renderOrders();
    } else {
      renderAppView();
    }
  } catch (err: any) {
    alert(err.message || 'Failed to delete order.');
  }
}

async function submitBookingToBackend(bookingData: {
  customer_name: string;
  customer_phone: string;
  customer_address: string;
  landmark?: string;
  latitude?: number;
  longitude?: number;
  shop_name?: string;
  pickup_date?: string;
  pickup_time?: string;
  items: SelectedItem[];
  estimated_amount: number;
}): Promise<Booking> {
  const bookingCode = 'SG-' + Math.floor(100000 + Math.random() * 900000);
  const pickupCharge = bookingData.estimated_amount >= 500 ? 0 : 50;
  const createdAtTimestamp = new Date().toISOString();

  const now = new Date();
  const autoDate = bookingData.pickup_date || now.toISOString().split('T')[0];
  const autoTime = bookingData.pickup_time || now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });

  const newBookingPayload = {
    booking_code: bookingCode,
    customer_id: currentUser ? currentUser.id : null,
    customer_name: bookingData.customer_name,
    customer_phone: bookingData.customer_phone,
    customer_address: bookingData.customer_address,
    landmark: bookingData.landmark || null,
    latitude: bookingData.latitude ?? null,
    longitude: bookingData.longitude ?? null,
    shop_name: bookingData.shop_name || null,
    pickup_date: autoDate,
    pickup_time: autoTime,
    items: bookingData.items,
    estimated_amount: bookingData.estimated_amount,
    pickup_charge: pickupCharge,
    status: 'Pending Buyer Review',
    created_at: createdAtTimestamp
  };

  const { data, error } = await supabase
    .from('bookings')
    .insert([newBookingPayload])
    .select();

  if (error) {
    console.error('Supabase booking creation error:', error);
    const localBookingObj: Booking = { ...newBookingPayload, id: 'local-' + Date.now() };
    saveBookingToLocalStorage(localBookingObj);
    return localBookingObj;
  }

  if (!data || data.length === 0) {
    const localBookingObj: Booking = { ...newBookingPayload, id: 'local-' + Date.now() };
    saveBookingToLocalStorage(localBookingObj);
    return localBookingObj;
  }

  const savedBooking = data[0] as Booking;
  saveBookingToLocalStorage(savedBooking);
  return savedBooking;
}

async function fetchUserOrders(): Promise<{ orders: Booking[]; error: string | null }> {
  const localOrders: Booking[] = JSON.parse(localStorage.getItem('scrapgo_bookings') || '[]');

  try {
    let query = supabase.from('bookings').select('*').order('created_at', { ascending: false });
    if (currentUser) {
      query = query.eq('customer_id', currentUser.id);
    }

    const { data, error } = await query;
    if (error) {
      console.error('Error fetching user orders:', error);
      return { orders: localOrders, error: 'Unable to connect to live database. Showing stored local bookings.' };
    }
    const combined = [...(data || []), ...localOrders];
    const uniqueOrders = Array.from(new Set(combined.map(item => item.booking_code)))
      .map(code => combined.find(item => item.booking_code === code)!);
    return { orders: uniqueOrders, error: null };
  } catch (err: any) {
    return { orders: localOrders, error: err?.message || 'Failed to fetch bookings.' };
  }
}

async function fetchAdminBookings(): Promise<Booking[]> {
  const localOrders: Booking[] = JSON.parse(localStorage.getItem('scrapgo_bookings') || '[]');
  try {
    const { data, error } = await supabase
      .from('bookings')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    const combined = [...(data || []), ...localOrders];
    return Array.from(new Set(combined.map(item => item.booking_code)))
      .map(code => combined.find(item => item.booking_code === code)!);
  } catch (err) {
    console.error('Error fetching admin bookings:', err);
    return localOrders;
  }
}

async function fetchPickupBoys(): Promise<UserProfile[]> {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('role', 'pickup_boy');

    if (error) throw error;
    return (data || []) as UserProfile[];
  } catch (err) {
    console.error('Error fetching pickup boys:', err);
    return [];
  }
}

async function fetchPickupBoyBookings(assignedOnly = true): Promise<Booking[]> {
  const localOrders: Booking[] = JSON.parse(localStorage.getItem('scrapgo_bookings') || '[]');
  try {
    let query = supabase.from('bookings').select('*');

    if (assignedOnly) {
      query = query.eq('pickup_boy_id', currentUser?.id);
    } else {
      query = query.eq('status', 'Pending Pickup').is('pickup_boy_id', null);
    }
    const { data, error } = await query.order('created_at', { ascending: false });
    const combined = [...(data || []), ...localOrders.filter(b => assignedOnly ? b.pickup_boy_id === currentUser?.id : (b.status === 'Pending Pickup' && !b.pickup_boy_id))];
    return Array.from(new Set(combined.map(item => item.booking_code)))
      .map(code => combined.find(item => item.booking_code === code)!);
  } catch (err) {
    console.error('Error fetching pickup boy bookings:', err);
    return localOrders.filter(b => assignedOnly ? b.pickup_boy_id === currentUser?.id : (b.status === 'Pending Pickup' && !b.pickup_boy_id));
  }
}

async function fetchBuyerRequests(): Promise<Booking[]> {
  const localOrders: Booking[] = JSON.parse(localStorage.getItem('scrapgo_bookings') || '[]');
  try {
    const { data, error } = await supabase
      .from('bookings')
      .select('*')
      .in('status', ['Pending Buyer Review', 'Pending Pickup', 'Assigned'])
      .order('created_at', { ascending: false });

    const combined = [...(data || []), ...localOrders.filter(b => ['Pending Buyer Review', 'Pending Pickup', 'Assigned'].includes(b.status))];
    const uniqueBookings = Array.from(new Set(combined.map(item => item.booking_code)))
      .map(code => combined.find(item => item.booking_code === code)!);
    return uniqueBookings;
  } catch (err) {
    console.error('Error fetching buyer requests:', err);
    return localOrders.filter(b => ['Pending Buyer Review', 'Pending Pickup', 'Assigned'].includes(b.status));
  }
}

async function fetchCollectedBookings(): Promise<Booking[]> {
  const localOrders: Booking[] = JSON.parse(localStorage.getItem('scrapgo_bookings') || '[]');
  try {
    const { data, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('status', 'Collected')
      .order('created_at', { ascending: false });

    const combined = [...(data || []), ...localOrders.filter(b => b.status === 'Collected')];
    return Array.from(new Set(combined.map(item => item.booking_code)))
      .map(code => combined.find(item => item.booking_code === code)!);
  } catch (err) {
    console.error('Error fetching collected bookings:', err);
    return localOrders.filter(b => b.status === 'Collected');
  }
}

async function requestPickerForBooking(bookingId: string): Promise<void> {
  try {
    const updatePayload = {
      buyer_id: currentUser ? currentUser.id : null,
      status: 'Pending Pickup'
    };

    if (bookingId && isUuid(bookingId)) {
      const { error } = await supabase
        .from('bookings')
        .update(updatePayload)
        .eq('id', bookingId);
      if (error) console.error('Supabase request picker error:', error);
    }

    const localBookings: Booking[] = JSON.parse(localStorage.getItem('scrapgo_bookings') || '[]');
    const bIndex = localBookings.findIndex(b => b.id === bookingId);
    if (bIndex !== -1) {
      localBookings[bIndex].buyer_id = currentUser ? currentUser.id : undefined;
      localBookings[bIndex].status = 'Pending Pickup';
      localStorage.setItem('scrapgo_bookings', JSON.stringify(localBookings));
    }

    alert('Request sent to available Pickup Boys!');
    renderBuyerDashboard();
  } catch (err: any) {
    alert(err.message || 'Failed to request pickup boy.');
  }
}

async function buyerSelfAssignAndCollect(bookingId: string, pickerName?: string): Promise<void> {
  try {
    const updatePayload: any = {
      buyer_id: currentUser ? currentUser.id : null,
      status: 'Assigned'
    };

    if (pickerName) {
      updatePayload.shop_name = `Picker: ${pickerName}`;
    }

    if (bookingId && isUuid(bookingId)) {
      const { error } = await supabase
        .from('bookings')
        .update(updatePayload)
        .eq('id', bookingId);
      if (error) console.error('Supabase self assign error:', error);
    }

    const localBookings: Booking[] = JSON.parse(localStorage.getItem('scrapgo_bookings') || '[]');
    const bIndex = localBookings.findIndex(b => b.id === bookingId);
    if (bIndex !== -1) {
      localBookings[bIndex].buyer_id = currentUser ? currentUser.id : undefined;
      localBookings[bIndex].status = 'Assigned';
      if (pickerName) localBookings[bIndex].shop_name = `Picker: ${pickerName}`;
      localStorage.setItem('scrapgo_bookings', JSON.stringify(localBookings));
    }

    alert('Assigned to self / picker! You can now enter actual weight & scrap photo.');
    renderBuyerDashboard();
  } catch (err: any) {
    alert(err.message || 'Failed to self assign.');
  }
}

async function claimBooking(bookingId: string): Promise<void> {
  if (!currentUser) {
    alert('Unauthorized action. Please log in as Pickup Boy.');
    return;
  }

  try {
    if (bookingId && isUuid(bookingId)) {
      const { error } = await supabase
        .from('bookings')
        .update({
          pickup_boy_id: currentUser.id,
          status: 'Assigned'
        })
        .eq('id', bookingId)
        .eq('status', 'Pending Pickup')
        .is('pickup_boy_id', null);

      if (error) {
        console.error('Supabase claim error:', error);
      }
    }

    const localBookings: Booking[] = JSON.parse(localStorage.getItem('scrapgo_bookings') || '[]');
    const bIndex = localBookings.findIndex(b => b.id === bookingId);
    if (bIndex !== -1) {
      localBookings[bIndex].pickup_boy_id = currentUser.id;
      localBookings[bIndex].status = 'Assigned';
      localStorage.setItem('scrapgo_bookings', JSON.stringify(localBookings));
    }

    alert('Pickup accepted successfully!');
    currentPickupBoyTab = 'assigned';
    renderAppView();
  } catch (err: any) {
    alert(err.message || 'Failed to accept pickup.');
  }
}

async function assignPickupBoyToBooking(bookingId: string, pickupBoyId: string, newStatus?: string): Promise<void> {
  try {
    const updatePayload: { pickup_boy_id: string | null; status?: string } = {
      pickup_boy_id: pickupBoyId || null
    };

    if (newStatus) {
      updatePayload.status = newStatus;
    } else if (pickupBoyId) {
      updatePayload.status = 'Assigned';
    }

    if (bookingId && isUuid(bookingId)) {
      const { error } = await supabase
        .from('bookings')
        .update(updatePayload)
        .eq('id', bookingId);
      if (error) console.error('Supabase assign error:', error);
    }

    const localBookings: Booking[] = JSON.parse(localStorage.getItem('scrapgo_bookings') || '[]');
    const bIndex = localBookings.findIndex(b => b.id === bookingId);
    if (bIndex !== -1) {
      localBookings[bIndex].pickup_boy_id = pickupBoyId || undefined;
      if (updatePayload.status) localBookings[bIndex].status = updatePayload.status;
      localStorage.setItem('scrapgo_bookings', JSON.stringify(localBookings));
    }

    alert('Pickup Boy assigned successfully!');
    renderAppView();
  } catch (err: any) {
    alert(err.message || 'Failed to assign pickup boy.');
  }
}

async function acceptScrap(bookingId: string): Promise<void> {
  if (!currentUser) {
    alert('Unauthorized action.');
    return;
  }

  try {
    if (bookingId && isUuid(bookingId)) {
      const { error: updateError } = await supabase
        .from('bookings')
        .update({
          buyer_id: currentUser.id,
          status: 'Completed'
        })
        .eq('id', bookingId);

      if (updateError) {
        console.error('Supabase update error on accept scrap:', updateError);
      }
    }

    const localBookings: Booking[] = JSON.parse(localStorage.getItem('scrapgo_bookings') || '[]');
    const bIndex = localBookings.findIndex(b => b.id === bookingId);
    if (bIndex !== -1) {
      localBookings[bIndex].buyer_id = currentUser.id;
      localBookings[bIndex].status = 'Completed';
      localStorage.setItem('scrapgo_bookings', JSON.stringify(localBookings));
    }

    alert('Scrap payment accepted and marked Completed! 🎉');
    renderBuyerDashboard();
  } catch (err: any) {
    alert(err.message || 'Failed to accept scrap.');
  }
}

async function saveCollectionData(
  bookingId: string,
  updatedItems: SelectedItem[],
  photoFile?: File,
  bookingCode?: string,
  existingPhotoUrl?: string
): Promise<boolean> {
  try {
    let scrapPhotoUrl = existingPhotoUrl || null;

    if (photoFile) {
      const uploadedUrl = await uploadScrapPhoto(photoFile, bookingCode || bookingId);
      if (uploadedUrl) {
        scrapPhotoUrl = uploadedUrl;
      }
    }

    const actualAmt = calculateActualAmount(updatedItems);
    const updatePayload: any = {
      items: updatedItems,
      actual_amount: actualAmt,
      status: 'Collected'
    };

    if (scrapPhotoUrl) {
      updatePayload.scrap_photo_url = scrapPhotoUrl;
    }

    if (bookingId && isUuid(bookingId)) {
      const { error } = await supabase
        .from('bookings')
        .update(updatePayload)
        .eq('id', bookingId);

      if (error) console.error('Error saving collection to Supabase:', error);
    }

    const localBookings: Booking[] = JSON.parse(localStorage.getItem('scrapgo_bookings') || '[]');
    const bIndex = localBookings.findIndex(b => b.id === bookingId);
    if (bIndex !== -1) {
      localBookings[bIndex].items = updatedItems;
      localBookings[bIndex].actual_amount = actualAmt;
      localBookings[bIndex].status = 'Collected';
      if (scrapPhotoUrl) localBookings[bIndex].scrap_photo_url = scrapPhotoUrl;
      localStorage.setItem('scrapgo_bookings', JSON.stringify(localBookings));
    }

    return true;
  } catch (err) {
    console.error('Save collection error:', err);
    return false;
  }
}

function getHeaderHTML() {
  const userGreeting = currentProfile?.full_name
    ? `<span>Hi, <strong>${currentProfile.full_name}</strong> (${currentProfile.role.toUpperCase()})</span>`
    : currentUser?.email
    ? `<span>${currentUser.email}</span>`
    : `<span>Guest</span>`;

  return `
  <div class="header">
    <div style="display: flex; justify-content: space-between; align-items: center;">
      <div>
        <h2>ScrapGo ♻️</h2>
        <p>Doorstep Scrap Pickup</p>
      </div>
      <div>
        ${currentUser 
          ? `<button id="logout-btn" class="btn" style="background: rgba(255,255,255,0.2); color: white; padding: 4px 10px; font-size: 12px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.4); cursor: pointer;">Logout</button>`
          : `<button id="login-nav-btn" class="btn" style="background: white; color: #16a34a; padding: 4px 10px; font-size: 12px; font-weight: bold; border-radius: 4px; border: none; cursor: pointer;">Login / Access</button>`}
      </div>
    </div>
    <div style="margin-top: 8px; font-size: 13px; opacity: 0.95;">${userGreeting}</div>
  </div>`;
}

function attachHeaderListeners() {
  document.getElementById('logout-btn')?.addEventListener('click', handleLogout);
  document.getElementById('login-nav-btn')?.addEventListener('click', () => renderAuthView(false));
}

function renderHome() {
  currentViewName = 'home';
  app.innerHTML = `
  ${getHeaderHTML()}
  <div class="content">
    <div class="card">
      <h3>Sell Your Scrap Easily</h3>
      <p>Select items, calculate estimate, choose pickup date/time, and schedule!</p>
      <button id="start-calc-btn" class="btn primary-btn" style="margin-top: 15px;">Book Pickup Now</button>
    </div>
    <div class="card" style="margin-top: 15px;">
      <h3>Track My Bookings</h3>
      <p>Track your active and previous scrap pickups in real time.</p>
      <button id="view-orders-btn" class="btn secondary-btn" style="margin-top: 10px;">My Bookings & Status</button>
    </div>
  </div>`;

  attachHeaderListeners();
  document.getElementById('start-calc-btn')?.addEventListener('click', renderCalculator);
  document.getElementById('view-orders-btn')?.addEventListener('click', renderOrders);
}

function renderAuthView(isSignup = false) {
  currentViewName = 'auth';
  const roleTitles = {
    customer: 'Customer Portal',
    pickup_boy: 'Pickup Boy Portal',
    buyer: 'Buyer Portal',
    admin: 'Admin Portal'
  };

  app.innerHTML = `
  <div class="header">
    <button id="back-home-btn" class="back-btn">← Back</button>
    <h2>${isSignup ? 'Create Account' : 'Login'}</h2>
  </div>
  <div class="content">
    <div style="display: flex; gap: 4px; margin-bottom: 15px; background: #f3f4f6; padding: 4px; border-radius: 8px;">
      <button id="tab-customer" class="btn" style="flex: 1; padding: 6px; font-size: 11px; background: ${selectedAuthRole === 'customer' ? '#16a34a' : 'transparent'}; color: ${selectedAuthRole === 'customer' ? 'white' : '#374151'}; font-weight: bold; border-radius: 6px;">👤 Customer</button>
      <button id="tab-pickup" class="btn" style="flex: 1; padding: 6px; font-size: 11px; background: ${selectedAuthRole === 'pickup_boy' ? '#16a34a' : 'transparent'}; color: ${selectedAuthRole === 'pickup_boy' ? 'white' : '#374151'}; font-weight: bold; border-radius: 6px;">🛵 Pickup Boy</button>
      <button id="tab-buyer" class="btn" style="flex: 1; padding: 6px; font-size: 11px; background: ${selectedAuthRole === 'buyer' ? '#16a34a' : 'transparent'}; color: ${selectedAuthRole === 'buyer' ? 'white' : '#374151'}; font-weight: bold; border-radius: 6px;">🏭 Buyer</button>
      <button id="tab-admin" class="btn" style="flex: 1; padding: 6px; font-size: 11px; background: ${selectedAuthRole === 'admin' ? '#16a34a' : 'transparent'}; color: ${selectedAuthRole === 'admin' ? 'white' : '#374151'}; font-weight: bold; border-radius: 6px;">👑 Admin</button>
    </div>

    <div class="card">
      <h4 style="text-align: center; margin-bottom: 12px; color: #15803d;">
        ${roleTitles[selectedAuthRole]}
      </h4>
      <form id="auth-form">
        ${isSignup ? `
        <div style="margin-bottom: 10px;"> 
          <label>Full Name</label> 
          <input type="text" id="auth-name" required placeholder="Enter full name" style="width: 100%; padding: 8px; margin-top: 4px;" /> 
        </div> 
        <div style="margin-bottom: 10px;"> 
          <label>Phone Number</label> 
          <input type="tel" id="auth-phone" required placeholder="10-digit phone number" style="width: 100%; padding: 8px; margin-top: 4px;" /> 
        </div> 
        <div style="margin-bottom: 10px;"> 
          <label>Address</label> 
          <textarea id="auth-address" required placeholder="Enter address" style="width: 100%; padding: 8px; margin-top: 4px;"></textarea> 
        </div>` : ''}

        <div style="margin-bottom: 10px;">
          <label>Email Address</label>
          <input type="email" id="auth-email" required placeholder="name@email.com" style="width: 100%; padding: 8px; margin-top: 4px;" />
        </div>
        <div style="margin-bottom: 10px;">
          <label>Password</label>
          <input type="password" id="auth-pass" required placeholder="••••••••" style="width: 100%; padding: 8px; margin-top: 4px;" />
        </div>
        <button type="submit" class="btn primary-btn" style="width: 100%; margin-top: 10px;">
          ${isSignup ? 'Sign Up as ' + selectedAuthRole.toUpperCase() : 'Log In'}
        </button>
      </form>
      <p style="text-align: center; margin-top: 15px; font-size: 14px;">
        ${isSignup ? 'Already have an account?' : "Don't have an account?"}
        <a href="#" id="toggle-auth" style="color: #16a34a; font-weight: bold;">
          ${isSignup ? 'Login' : 'Sign Up'}
        </a>
      </p>
    </div>
  </div>`;

  document.getElementById('tab-customer')?.addEventListener('click', () => {
    selectedAuthRole = 'customer';
    renderAuthView(isSignup);
  });

  document.getElementById('tab-pickup')?.addEventListener('click', () => {
    selectedAuthRole = 'pickup_boy';
    renderAuthView(isSignup);
  });

  document.getElementById('tab-buyer')?.addEventListener('click', () => {
    selectedAuthRole = 'buyer';
    renderAuthView(isSignup);
  });

  document.getElementById('tab-admin')?.addEventListener('click', () => {
    selectedAuthRole = 'admin';
    renderAuthView(isSignup);
  });

  document.getElementById('back-home-btn')?.addEventListener('click', renderAppView);
  document.getElementById('toggle-auth')?.addEventListener('click', (e) => {
    e.preventDefault();
    renderAuthView(!isSignup);
  });

  document.getElementById('auth-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = (document.getElementById('auth-email') as HTMLInputElement).value;
    const pass = (document.getElementById('auth-pass') as HTMLInputElement).value;

    if (isSignup) {
      const name = (document.getElementById('auth-name') as HTMLInputElement).value;
      const phone = (document.getElementById('auth-phone') as HTMLInputElement).value;
      const address = (document.getElementById('auth-address') as HTMLInputElement).value;
      await handleSignUpWithRole(email, pass, name, phone, address, selectedAuthRole);
    } else {
      await handleLogin(email, pass);
    }
  });
}

async function renderAdminDashboard() {
  currentViewName = 'admin';
  if (currentProfile?.role !== 'admin') {
    alert('Access denied. Admin privileges required.');
    renderHome();
    return;
  }

  app.innerHTML = `
  ${getHeaderHTML()}
  <div class="content">
    <div class="card">
      <h3>👑 Admin Control Center</h3>
      <p style="font-size: 13px; color: #555;">Manage customer bookings, assign pickup boys, view photos, and update status.</p>
    </div>
    <div id="admin-orders-list" style="margin-top: 15px;">
      <p>Loading all orders...</p>
    </div>
  </div>`;
  attachHeaderListeners();

  const [bookings, pickupBoys] = await Promise.all([
    fetchAdminBookings(),
    fetchPickupBoys()
  ]);

  const listContainer = document.getElementById('admin-orders-list')!;

  if (bookings.length === 0) {
    listContainer.innerHTML = `<p>No bookings found in database.</p>`;
    return;
  }

  listContainer.innerHTML = bookings.map(b => {
    const pickupBoyOptionsHTML = pickupBoys.map(pb =>
      `<option value="${pb.id}" ${b.pickup_boy_id === pb.id ? 'selected' : ''}> ${pb.full_name || pb.phone || pb.id.slice(0, 8)} </option>`
    ).join('');

    const pickupCharge = b.pickup_charge ?? (b.estimated_amount >= 500 ? 0 : 50);
    const actual = typeof b.actual_amount === 'number' ? b.actual_amount : calculateActualAmount(b.items);
    const commission = typeof b.commission_amount === 'number' ? b.commission_amount : actual * 0.10;
    const netCustomerPayout = Math.max(0, actual - pickupCharge);

    return `
    <div class="card" style="margin-bottom: 12px; border-left: 4px solid #16a34a;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <strong>${b.booking_code}</strong>
        <div>
          <span style="font-size: 12px; padding: 2px 8px; background: #e0f2fe; color: #0369a1; border-radius: 4px;">${b.status}</span>
          ${['Completed', 'Cancelled'].includes(b.status) ?
            `<button class="btn delete-order-btn" data-id="${b.id || ''}" data-code="${b.booking_code}" style="background: #ef4444; color: white; border: none; padding: 2px 6px; border-radius: 4px; font-size: 11px; cursor: pointer; margin-left: 6px;">🗑️ Delete</button>`
            : ''}
        </div>
      </div>
      <p style="font-size: 11px; color: #888; margin-top: 2px;">🕒 Order Placed: <strong>${formatDateTime(b.created_at)}</strong></p>
      <p style="font-size: 13px; margin-top: 6px;">Customer: <strong>${b.customer_name}</strong> (${b.customer_phone})</p>
      <p style="font-size: 12px; color: #666;">Address: ${b.customer_address}</p>
      ${(b.pickup_date || b.pickup_time) ? `<p style="font-size: 12px; color: #2563eb; font-weight: bold;">📅 Scheduled: ${b.pickup_date || 'Date N/A'} at ${b.pickup_time || 'Time N/A'}</p>` : ''} 
      ${b.landmark ? `<p style="font-size: 12px; color: #666;">Landmark: <strong>${b.landmark}</strong></p>` : ''}
      ${b.shop_name ? `<p style="font-size: 12px; color: #0369a1; font-weight: 600;">🏪 Preferred Shop / Buyer: ${b.shop_name}</p>` : ''}
      ${(b.latitude != null && b.longitude != null) ? `<p style="font-size: 12px; margin-top: 2px;"><a href="https://maps.google.com/?q=${b.latitude},${b.longitude}" target="_blank" rel="noopener noreferrer" style="color: #2563eb; font-weight: bold; text-decoration: none;">📍 View on Google Maps</a></p>` : ''}

      ${b.scrap_photo_url ? `<div style="margin-top: 8px; padding: 6px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px;"> <div style="font-size: 11px; font-weight: bold; color: #16a34a; margin-bottom: 4px;">📷 Uploaded Scrap Photo:</div> <img src="${b.scrap_photo_url}" alt="Collected Scrap" style="max-width: 100%; max-height: 180px; object-fit: contain; border-radius: 6px; border: 1px solid #cbd5e1;" /> </div>` : ''}

      <div style="margin-top: 8px; font-size: 12px; background: #f8fafc; padding: 6px 8px; border-radius: 6px; border: 1px solid #e2e8f0;">
        <div>Est. Scrap Value: <strong>₹${b.estimated_amount}</strong> | Delivery/Pickup Fee: <strong style="color:#dc2626;">-${pickupCharge === 0 ? 'FREE' : '₹' + pickupCharge}</strong></div>
        ${typeof b.actual_amount === 'number' ? `<div style="color: #16a34a; margin-top: 2px;">Actual Scrap Value: <strong>₹${actual}</strong></div> <div style="color: #dc2626; margin-top: 2px;">Platform Commission (10%): <strong>₹${commission.toFixed(2)}</strong></div> <div style="color: #15803d; font-weight: bold; margin-top: 2px;">Net Payable to Customer: <strong>₹${netCustomerPayout.toFixed(2)}</strong></div>` : ''}
      </div>

      <div style="margin-top: 10px; padding: 8px; background: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb;">
        <div style="margin-bottom: 8px;">
          <label style="font-size: 11px; font-weight: bold; color: #4b5563; display: block; margin-bottom: 2px;">Assigned Pickup Boy:</label>
          <select id="pb-select-${b.id}" style="width: 100%; padding: 6px; font-size: 12px; border-radius: 4px; border: 1px solid #ccc;">
            <option value="">-- Unassigned --</option>
            ${pickupBoyOptionsHTML}
          </select>
        </div>
        <div style="display: flex; gap: 8px; align-items: center;">
          <select id="status-select-${b.id}" style="flex: 1; padding: 6px; font-size: 12px; border-radius: 4px; border: 1px solid #ccc;">
            <option value="Pending Buyer Review" ${b.status === 'Pending Buyer Review' ? 'selected' : ''}>Pending Buyer Review</option>
            <option value="Pending Pickup" ${b.status === 'Pending Pickup' ? 'selected' : ''}>Pending Pickup</option>
            <option value="Assigned" ${b.status === 'Assigned' ? 'selected' : ''}>Assigned</option>
            <option value="Collected" ${b.status === 'Collected' ? 'selected' : ''}>Collected</option>
            <option value="Completed" ${b.status === 'Completed' ? 'selected' : ''}>Completed</option>
            <option value="Cancelled" ${b.status === 'Cancelled' ? 'selected' : ''}>Cancelled</option>
          </select>
          <button class="btn primary-btn update-admin-btn" data-id="${b.id}" style="padding: 6px 12px; font-size: 12px; width: auto;">Save Changes</button>
        </div>
      </div>
    </div>`;
  }).join('');

  document.querySelectorAll('.update-admin-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).getAttribute('data-id')!;
      const pbSelect = document.getElementById(`pb-select-${id}`) as HTMLSelectElement;
      const statusSelect = document.getElementById(`status-select-${id}`) as HTMLSelectElement;

      const selectedPbId = pbSelect.value;
      const selectedStatus = statusSelect.value;
      assignPickupBoyToBooking(id, selectedPbId, selectedStatus);
    });
  });

  document.querySelectorAll('.delete-order-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = (e.currentTarget as HTMLElement).getAttribute('data-id');
      const code = (e.currentTarget as HTMLElement).getAttribute('data-code');
      deleteBooking(id || undefined, code || undefined, false);
    });
  });
}

async function renderPickupBoyDashboard() {
  currentViewName = 'pickup_boy';
  app.innerHTML = `
  ${getHeaderHTML()}
  <div class="content">
    <div class="card">
      <h3>🛵 Pickup Boy Dashboard</h3>
      <p style="font-size: 13px; color: #555;">Manage assigned orders, enter actual weights, and upload scrap photos.</p>
    </div>

    <div style="display: flex; gap: 8px; margin-top: 12px; margin-bottom: 12px;">
      <button id="tab-pb-assigned" class="btn" style="flex: 1; padding: 8px; font-size: 12px; background: ${currentPickupBoyTab === 'assigned' ? '#16a34a' : '#e5e7eb'}; color: ${currentPickupBoyTab === 'assigned' ? 'white' : '#374151'}; font-weight: bold; border-radius: 6px;">
        📋 My Assigned Pickups
      </button>
      <button id="tab-pb-available" class="btn" style="flex: 1; padding: 8px; font-size: 12px; background: ${currentPickupBoyTab === 'available' ? '#16a34a' : '#e5e7eb'}; color: ${currentPickupBoyTab === 'available' ? 'white' : '#374151'}; font-weight: bold; border-radius: 6px;">
        ⚡ Available Requests
      </button>
    </div>
    <div id="pickup-orders-list">
      <p>Loading pickups...</p>
    </div>
  </div>`;
  attachHeaderListeners();

  document.getElementById('tab-pb-assigned')?.addEventListener('click', () => {
    currentPickupBoyTab = 'assigned';
    renderPickupBoyDashboard();
  });

  document.getElementById('tab-pb-available')?.addEventListener('click', () => {
    currentPickupBoyTab = 'available';
    renderPickupBoyDashboard();
  });

  const isAssignedTab = currentPickupBoyTab === 'assigned';
  const bookings = await fetchPickupBoyBookings(isAssignedTab);
  const listContainer = document.getElementById('pickup-orders-list')!;

  if (bookings.length === 0) {
    listContainer.innerHTML = `<div class="card" style="text-align: center; padding: 20px;"> <p style="color: #666; font-size: 13px;">${isAssignedTab ? 'No assigned pickups currently.' : 'No open pickup requests available right now.'}</p> </div>`;
    return;
  }

  listContainer.innerHTML = bookings.map(b => {
    const isUnassignedPending = b.status === 'Pending Pickup' && !b.pickup_boy_id;
    const isAssignedToMe = b.pickup_boy_id === currentUser?.id;
    const pickupCharge = b.pickup_charge ?? (b.estimated_amount >= 500 ? 0 : 50);
    const actualAmount = typeof b.actual_amount === 'number' ? b.actual_amount : calculateActualAmount(b.items);
    const netPayoutToCustomer = Math.max(0, actualAmount - pickupCharge);

    const itemsListHTML = (b.items || []).map((item, idx) => 
      `<div style="display: flex; justify-content: space-between; align-items: center; margin-top: 6px; padding: 6px 0; border-bottom: 1px dashed #eee; font-size: 12px;"> 
        <div> 
          <strong>${item.name}</strong> 
          <span style="color: #666;">(₹${item.rate}/kg)</span> 
          <br><small style="color: #888;">Est. Weight: ${item.weight || 0} kg</small> 
        </div> 
        ${isAssignedToMe && b.status === 'Assigned' ?
          `<div style="text-align: right;">
            <label style="font-size: 11px; color: #444; display: block; margin-bottom: 2px;">Actual Weight:</label>
            <input type="number" step="any" placeholder="0.0" class="actual-weight-input-${b.id}" data-booking-id="${b.id}" data-item-index="${idx}" value="${item.actual_weight ?? ''}" style="width: 85px; padding: 5px; font-size: 12px; border: 1px solid #3b82f6; border-radius: 4px; text-align: right;" /> kg
            <span class="save-status-${b.id}-${idx}" style="display: block; font-size: 10px; color: #16a34a; height: 12px; margin-top: 2px;"></span>
          </div>`
          : (typeof item.actual_weight === 'number' ?
            `<div style="text-align: right; font-size: 11px; color: #444;">
              Actual Weight: <strong>${item.actual_weight} kg</strong>
            </div>`
            : '')} 
      </div>`
    ).join('');

    return `
    <div class="card" style="margin-bottom: 12px; border-left: 4px solid ${isAssignedToMe ? '#16a34a' : '#d97706'};"> 
      <div style="display:flex; justify-content:space-between; align-items:center;"> 
        <strong>${b.booking_code}</strong> 
        <span style="font-size: 12px; padding: 2px 8px; background: #fef3c7; color: #b45309; border-radius: 4px;">${b.status}</span> 
      </div> 
      <p style="font-size: 11px; color: #888; margin-top: 2px;">🕒 Order Placed: <strong>${formatDateTime(b.created_at)}</strong></p> 
      <p style="font-size: 13px; margin-top: 6px;">Customer: <strong>${b.customer_name}</strong></p> 
      <p style="font-size: 12px; color: #666;">Phone: <a href="tel:${b.customer_phone}">${b.customer_phone}</a></p> 
      <p style="font-size: 12px; color: #666;">Address: ${b.customer_address}</p> 
      ${(b.pickup_date || b.pickup_time) ? `<p style="font-size: 12px; color: #2563eb; font-weight: bold;">📅 Pickup Scheduled: ${b.pickup_date || ''} (${b.pickup_time || ''})</p>` : ''} 
      ${b.landmark ? `<p style="font-size: 12px; color: #666;">Landmark: <strong>${b.landmark}</strong></p>` : ''} 
      ${b.shop_name ? `<p style="font-size: 12px; color: #0369a1; font-weight: 600;">🏪 Preferred Shop / Buyer: ${b.shop_name}</p>` : ''} 
      ${(b.latitude != null && b.longitude != null) ? `<p style="font-size: 12px; margin-top: 4px;"><a href="https://maps.google.com/?q=${b.latitude},${b.longitude}" target="_blank" rel="noopener noreferrer" style="color: #2563eb; font-weight: bold; text-decoration: none;">📍 Open Location in Maps</a></p>` : ''}

      <div style="margin-top: 6px; font-size: 12px; color: #374151; background: #f8fafc; padding: 6px; border-radius: 4px;">
        <div>Est. Scrap Value: <strong>₹${b.estimated_amount}</strong></div> 
        <div style="color: #dc2626;">Delivery/Pickup Fee Deducted: <strong>-${pickupCharge === 0 ? 'FREE' : '₹' + pickupCharge}</strong></div>
      </div>

      ${b.items && b.items.length > 0 ? ` 
      <div style="margin-top: 10px; padding: 8px; background: #f9fafb; border-radius: 6px; border: 1px solid #f3f4f6;"> 
        <h5 style="margin: 0 0 4px 0; font-size: 12px; color: #374151;">Scrap Items & Actual Weight Entry:</h5> 
        ${itemsListHTML}
        ${isAssignedToMe ? ` 
        <div style="margin-top: 10px; padding-top: 6px; border-top: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: center; font-size: 13px;"> 
          <span style="color: #374151; font-weight: 600;">Net Cash Payable to Customer:</span> 
          <strong style="color: #16a34a; font-size: 14px;" id="actual-amount-display-${b.id}">₹${netPayoutToCustomer.toFixed(2)}</strong>
        </div>` : ''} 
      </div>` : ''}

      ${isAssignedToMe && b.status === 'Assigned' ? 
        `<div style="margin-top: 10px; padding: 8px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 6px;"> 
          <label style="font-size: 12px; font-weight: bold; color: #1e40af; display: block; margin-bottom: 4px;">📸 Upload Collected Scrap Photo:</label> 
          <input type="file" accept="image/*" id="scrap-photo-file-${b.id}" style="font-size: 12px; width: 100%;" /> 
          <div id="photo-preview-container-${b.id}" style="margin-top: 6px; ${b.scrap_photo_url ? '' : 'display: none;'}"> 
            <img id="photo-preview-img-${b.id}" src="${b.scrap_photo_url || ''}" alt="Scrap Preview" style="max-width: 100%; max-height: 150px; border-radius: 6px; border: 1px solid #ccc; object-fit: contain;" /> 
          </div> 
        </div>` 
        : (b.scrap_photo_url ? `<div style="margin-top: 8px; padding: 6px; background: #f0fdf4; border-radius: 6px; border: 1px solid #bbf7d0;"> <span style="font-size: 11px; font-weight: bold; color: #16a34a; display: block; margin-bottom: 4px;">📷 Uploaded Scrap Photo:</span> <img src="${b.scrap_photo_url}" alt="Scrap Photo" style="max-width: 100%; max-height: 150px; border-radius: 6px; border: 1px solid #ccc; object-fit: contain;" /> </div>` : '')}

      <div style="margin-top: 10px; display: flex; gap: 8px;">
        ${isUnassignedPending ? `<button class="btn primary-btn accept-btn" data-id="${b.id}" style="padding: 8px; font-size: 12px; background: #2563eb; width: 100%;">Accept Pickup</button>` : ''}
        ${isAssignedToMe && b.status === 'Assigned' ? `<button class="btn primary-btn mark-collected-btn" data-id="${b.id}" data-code="${b.booking_code}" style="padding: 8px; font-size: 12px; width: 100%;">Save Actual Weights & Mark Collected</button>` : ''}
      </div>
    </div>`;
  }).join('');

  document.querySelectorAll('.accept-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).getAttribute('data-id')!;
      if (id) claimBooking(id);
    });
  });

  bookings.forEach(b => {
    const fileInput = document.getElementById(`scrap-photo-file-${b.id}`) as HTMLInputElement;
    const previewContainer = document.getElementById(`photo-preview-container-${b.id}`);
    const previewImg = document.getElementById(`photo-preview-img-${b.id}`) as HTMLImageElement;

    if (fileInput) {
      fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        if (file && previewContainer && previewImg) {
          const reader = new FileReader();
          reader.onload = (e) => {
            previewImg.src = e.target?.result as string;
            previewContainer.style.display = 'block';
          };
          reader.readAsDataURL(file);
        }
      });
    }
  });

  document.querySelectorAll('.mark-collected-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const btnElem = e.currentTarget as HTMLButtonElement;
      const id = btnElem.getAttribute('data-id')!;
      const code = btnElem.getAttribute('data-code')!;
      const booking = bookings.find(b => b.id === id);

      if (booking && id) {
        btnElem.disabled = true;
        btnElem.textContent = 'Saving & Uploading...';

        const updatedItems = booking.items.map((item, idx) => {
          const inputElem = document.querySelector(`.actual-weight-input-${id}[data-item-index="${idx}"]`) as HTMLInputElement;
          const valStr = inputElem ? inputElem.value.trim() : '';
          const actWeight = valStr !== '' ? parseFloat(valStr) : item.weight;
          return {
            ...item,
            actual_weight: isNaN(actWeight) ? item.weight : actWeight
          };
        });

        const fileInput = document.getElementById(`scrap-photo-file-${id}`) as HTMLInputElement;
        const photoFile = fileInput?.files?.[0];

        const success = await saveCollectionData(id, updatedItems, photoFile, code, booking.scrap_photo_url);

        if (success) {
          alert('Scrap collection completed successfully!');
          renderPickupBoyDashboard();
        } else {
          alert('Failed to save collection. Please try again.');
          btnElem.disabled = false;
          btnElem.textContent = 'Save Actual Weights & Mark Collected';
        }
      }
    });
  });

  document.querySelectorAll('[class^="actual-weight-input-"]').forEach(inputElem => {
    inputElem.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement;
      const bookingId = target.getAttribute('data-booking-id')!;
      const booking = bookings.find(b => b.id === bookingId);
      if (!booking) return;

      let currentSum = 0;
      booking.items.forEach((item, idx) => {
        const itemInput = document.querySelector(`.actual-weight-input-${bookingId}[data-item-index="${idx}"]`) as HTMLInputElement;
        const val = itemInput ? parseFloat(itemInput.value) : (item.actual_weight || 0);
        if (!isNaN(val) && val > 0) {
          currentSum += val * item.rate;
        }
      });

      const pickupCharge = booking.pickup_charge ?? (booking.estimated_amount >= 500 ? 0 : 50);
      const netPayout = Math.max(0, currentSum - pickupCharge);
      const actualAmtElem = document.getElementById(`actual-amount-display-${bookingId}`);
      if (actualAmtElem) {
        actualAmtElem.textContent = `₹${netPayout.toFixed(2)}`;
      }
    });
  });
}

async function renderBuyerDashboard() {
  currentViewName = 'buyer';
  app.innerHTML = `
  ${getHeaderHTML()}
  <div class="content">
    <div class="card">
      <h3>🏭 Buyer & Shop Dashboard</h3>
      <p style="font-size: 13px; color: #555;">Welcome, ${currentProfile?.full_name || 'Buyer'}!</p>
      <p style="font-size: 12px; color: #666;">Manage direct customer requests, self-pickups & collected scrap batches.</p>
    </div>

    <div style="display: flex; gap: 8px; margin-top: 12px; margin-bottom: 12px;">
      <button id="tab-buyer-requests" class="btn" style="flex: 1; padding: 8px; font-size: 12px; background: ${currentBuyerTab === 'requests' ? '#16a34a' : '#e5e7eb'}; color: ${currentBuyerTab === 'requests' ? 'white' : '#374151'}; font-weight: bold; border-radius: 6px;">
        📥 Customer Requests
      </button>
      <button id="tab-buyer-collected" class="btn" style="flex: 1; padding: 8px; font-size: 12px; background: ${currentBuyerTab === 'collected' ? '#16a34a' : '#e5e7eb'}; color: ${currentBuyerTab === 'collected' ? 'white' : '#374151'}; font-weight: bold; border-radius: 6px;">
        📦 Collected Batches
      </button>
    </div>
    <div id="buyer-content-list" style="margin-top: 10px;">
      <p style="font-size: 14px; color: #666;">Loading...</p>
    </div>
  </div>`;
  attachHeaderListeners();

  document.getElementById('tab-buyer-requests')?.addEventListener('click', () => {
    currentBuyerTab = 'requests';
    renderBuyerDashboard();
  });

  document.getElementById('tab-buyer-collected')?.addEventListener('click', () => {
    currentBuyerTab = 'collected';
    renderBuyerDashboard();
  });

  const listContainer = document.getElementById('buyer-content-list')!;

  if (currentBuyerTab === 'requests') {
    const buyerRequests = await fetchBuyerRequests();
    if (buyerRequests.length === 0) {
      listContainer.innerHTML = `<div class="card"><p style="font-size: 13px; color: #666; text-align: center;">No new customer requests right now.</p></div>`;
      return;
    }

    listContainer.innerHTML = buyerRequests.map(b => {
      const isPendingReview = b.status === 'Pending Buyer Review';
      const isAssignedToBuyer = b.buyer_id === currentUser?.id || b.status === 'Assigned';

      const itemsListHTML = (b.items || []).map((item, idx) => 
        `<div style="display: flex; justify-content: space-between; align-items: center; margin-top: 6px; padding: 6px 0; border-bottom: 1px dashed #eee; font-size: 12px;"> 
          <div> 
            <strong>${item.name}</strong> 
            <span style="color: #666;">(₹${item.rate}/kg)</span> 
            <br><small style="color: #888;">Est. Weight: ${item.weight || 0} kg</small> 
          </div> 
          ${isAssignedToBuyer && b.status === 'Assigned' ?
            `<div style="text-align: right;">
              <label style="font-size: 11px; color: #444; display: block; margin-bottom: 2px;">Actual Weight:</label>
              <input type="number" step="any" placeholder="0.0" class="buyer-actual-weight-input-${b.id}" data-booking-id="${b.id}" data-item-index="${idx}" value="${item.actual_weight ?? ''}" style="width: 85px; padding: 5px; font-size: 12px; border: 1px solid #16a34a; border-radius: 4px; text-align: right;" /> kg
            </div>`
            : (typeof item.actual_weight === 'number' ?
              `<div style="text-align: right; font-size: 11px; color: #444;">
                Actual Weight: <strong>${item.actual_weight} kg</strong>
              </div>`
              : '')} 
        </div>`
      ).join('');

      return `
      <div class="card" style="margin-bottom: 12px; border-left: 4px solid #2563eb;"> 
        <div style="display: flex; justify-content: space-between; align-items: center;"> 
          <strong>${b.booking_code}</strong> 
          <span style="font-size: 11px; padding: 2px 8px; background: #dbeafe; color: #1e40af; border-radius: 4px; font-weight: bold;">${b.status}</span> 
        </div> 
        <p style="font-size: 11px; color: #666; margin-top: 2px;">🕒 Order Placed: <strong>${formatDateTime(b.created_at)}</strong></p> 
        <p style="font-size: 13px; margin-top: 6px;">Customer: <strong>${b.customer_name}</strong> (${b.customer_phone})</p> 
        <p style="font-size: 12px; color: #666;">Address: ${b.customer_address}</p> 
        ${(b.pickup_date || b.pickup_time) ? `<p style="font-size: 12px; color: #2563eb; font-weight: bold; margin-top: 2px;">📅 Scheduled Slot: ${b.pickup_date || ''} at ${b.pickup_time || ''}</p>` : ''}
        <p style="font-size: 12px; color: #15803d; font-weight: 600; margin-top: 4px;">Est. Scrap Value: ₹${b.estimated_amount}</p>

        ${isPendingReview ? 
          `<div style="margin-top: 12px; padding-top: 10px; border-top: 1px dashed #cbd5e1; display: flex; flex-direction: column; gap: 8px;"> 
            <button class="btn req-picker-btn" data-id="${b.id}" style="background: #2563eb; color: white; padding: 8px; font-size: 12px; font-weight: bold; border-radius: 6px; border: none; cursor: pointer;"> 
              ⚡ Need Pickup Boy (Request Picker) 
            </button> 
            <div style="display: flex; gap: 6px; margin-top: 4px;"> 
              <input type="text" id="self-picker-name-${b.id}" placeholder="Enter Picker/Driver Name" style="flex: 1; padding: 6px; font-size: 12px; border: 1px solid #ccc; border-radius: 4px;" /> 
              <button class="btn self-picker-btn" data-id="${b.id}" style="background: #16a34a; color: white; padding: 6px 10px; font-size: 12px; font-weight: bold; border-radius: 4px; border: none; cursor: pointer; width: auto;"> 
                🛵 I Have Picker (Assign Self) 
              </button> 
            </div> 
          </div>` 
          : `
          <div style="margin-top: 8px; padding: 8px; background: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb;">
            <h5 style="margin: 0 0 4px 0; font-size: 12px; color: #374151;">Scrap Breakdown & Actual Weight Entry:</h5>
            ${itemsListHTML}
            ${b.status === 'Assigned' ? 
              `<div style="margin-top: 10px; padding: 8px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 6px;"> 
                <label style="font-size: 12px; font-weight: bold; color: #1e40af; display: block; margin-bottom: 4px;">📸 Upload Collected Scrap Photo:</label> 
                <input type="file" accept="image/*" id="buyer-scrap-photo-file-${b.id}" style="font-size: 12px; width: 100%;" /> 
                <div id="buyer-photo-preview-container-${b.id}" style="margin-top: 6px; ${b.scrap_photo_url ? '' : 'display: none;'}"> 
                  <img id="buyer-photo-preview-img-${b.id}" src="${b.scrap_photo_url || ''}" alt="Scrap Preview" style="max-width: 100%; max-height: 150px; border-radius: 6px; border: 1px solid #ccc; object-fit: contain;" /> 
                </div> 
              </div> 
              <button class="btn primary-btn buyer-collect-btn" data-id="${b.id}" data-code="${b.booking_code}" style="margin-top: 10px; width: 100%; padding: 8px; font-size: 12px;"> Save Actual Weights & Mark Collected </button>` : ''}
          </div>`} 
      </div>`;
    }).join('');

    document.querySelectorAll('.req-picker-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = (e.target as HTMLElement).getAttribute('data-id')!;
        if (id) requestPickerForBooking(id);
      });
    });

    document.querySelectorAll('.self-picker-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = (e.target as HTMLElement).getAttribute('data-id')!;
        const input = document.getElementById(`self-picker-name-${id}`) as HTMLInputElement;
        const pickerName = input ? input.value.trim() : '';
        if (id) buyerSelfAssignAndCollect(id, pickerName);
      });
    });

    buyerRequests.forEach(b => {
      const fileInput = document.getElementById(`buyer-scrap-photo-file-${b.id}`) as HTMLInputElement;
      const previewContainer = document.getElementById(`buyer-photo-preview-container-${b.id}`);
      const previewImg = document.getElementById(`buyer-photo-preview-img-${b.id}`) as HTMLImageElement;

      if (fileInput) {
        fileInput.addEventListener('change', () => {
          const file = fileInput.files?.[0];
          if (file && previewContainer && previewImg) {
            const reader = new FileReader();
            reader.onload = (e) => {
              previewImg.src = e.target?.result as string;
              previewContainer.style.display = 'block';
            };
            reader.readAsDataURL(file);
          }
        });
      }
    });

    document.querySelectorAll('.buyer-collect-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const btnElem = e.currentTarget as HTMLButtonElement;
        const id = btnElem.getAttribute('data-id')!;
        const code = btnElem.getAttribute('data-code')!;
        const booking = buyerRequests.find(b => b.id === id);

        if (booking && id) {
          btnElem.disabled = true;
          btnElem.textContent = 'Saving Collection...';

          const updatedItems = booking.items.map((item, idx) => {
            const inputElem = document.querySelector(`.buyer-actual-weight-input-${id}[data-item-index="${idx}"]`) as HTMLInputElement;
            const valStr = inputElem ? inputElem.value.trim() : '';
            const actWeight = valStr !== '' ? parseFloat(valStr) : item.weight;
            return {
              ...item,
              actual_weight: isNaN(actWeight) ? item.weight : actWeight
            };
          });

          const fileInput = document.getElementById(`buyer-scrap-photo-file-${id}`) as HTMLInputElement;
          const photoFile = fileInput?.files?.[0];

          const success = await saveCollectionData(id, updatedItems, photoFile, code, booking.scrap_photo_url);

          if (success) {
            alert('Self-pickup collection saved and marked as Collected!');
            renderBuyerDashboard();
          } else {
            alert('Failed to save collection.');
            btnElem.disabled = false;
            btnElem.textContent = 'Save Actual Weights & Mark Collected';
          }
        }
      });
    });

  } else {
    const collectedBookings = await fetchCollectedBookings();
    if (collectedBookings.length === 0) {
      listContainer.innerHTML = `<div class="card"><p style="font-size: 14px; color: #666; text-align: center; margin: 10px 0;">No collected scrap batches available.</p></div>`;
      return;
    }

    listContainer.innerHTML = collectedBookings.map(b => {
      const totalActual = typeof b.actual_amount === 'number' ? b.actual_amount : calculateActualAmount(b.items);
      const commission = totalActual * 0.10;
      const finalPayable = totalActual - commission;
      const itemsHTML = (b.items || []).map(item => {
        const actWeight = typeof item.actual_weight === 'number' && !isNaN(item.actual_weight) ? item.actual_weight : 0;
        const itemVal = actWeight * (item.rate || 0);
        return `<div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px dashed #eee; font-size: 12px;"> 
          <div> 
            <strong>${item.name}</strong> 
            <br><span style="color: #666;">${actWeight} kg × ₹${item.rate}/kg</span> 
          </div> 
          <div style="font-weight: 600; color: #15803d;"> ₹${itemVal} </div> 
        </div>`;
      }).join('');

      return `
      <div class="card" style="margin-bottom: 12px; border-left: 4px solid #16a34a;"> 
        <div style="display: flex; justify-content: space-between; align-items: center;"> 
          <strong>${b.booking_code}</strong> 
          <span style="font-size: 12px; padding: 2px 8px; background: #dcfce7; color: #15803d; border-radius: 4px; font-weight: 600;">${b.status}</span> 
        </div> 
        <p style="font-size: 11px; color: #666; margin-top: 2px;">🕒 Order Placed: <strong>${formatDateTime(b.created_at)}</strong></p> 
        <p style="font-size: 13px; margin-top: 6px;">Customer: <strong>${b.customer_name}</strong></p> 
        <p style="font-size: 12px; color: #666;">Address: ${b.customer_address}</p> 
        ${b.shop_name ? `<p style="font-size: 12px; color: #0369a1; font-weight: 600;">🏪 Designated Shop / Buyer: ${b.shop_name}</p>` : ''}

        ${b.scrap_photo_url ? `<div style="margin-top: 8px; padding: 6px; background: #f0fdf4; border-radius: 6px; border: 1px solid #bbf7d0;"> <span style="font-size: 11px; font-weight: bold; color: #16a34a; display: block; margin-bottom: 4px;">📷 Uploaded Scrap Photo:</span> <img src="${b.scrap_photo_url}" alt="Collected Scrap" style="max-width: 100%; max-height: 180px; border-radius: 6px; border: 1px solid #ccc; object-fit: contain;" /> </div>` : ''}

        <div style="margin-top: 10px; padding: 8px; background: #f9fafb; border-radius: 6px; border: 1px solid #f3f4f6;">
          <h5 style="margin: 0 0 6px 0; font-size: 12px; color: #374151;">Collected Scrap Breakdown:</h5>
          ${itemsHTML} 
          <div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid #e5e7eb;"> 
            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #374151;"> 
              <span>Total Scrap Value:</span> 
              <strong>₹${totalActual}</strong>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #dc2626; margin-top: 3px;">
              <span>Platform Commission (10%):</span>
              <strong>-₹${commission.toFixed(2)}</strong> 
            </div> 
            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 14px; font-weight: 700; color: #15803d; margin-top: 6px; padding-top: 6px; border-top: 1px dashed #cbd5e1;"> 
              <span>Final Buyer Payable:</span> 
              <strong>₹${finalPayable.toFixed(2)}</strong>
            </div>
          </div>
        </div>
        <div style="margin-top: 12px;">
          <button class="btn primary-btn accept-scrap-btn" data-id="${b.id}" style="width: 100%; padding: 8px; font-size: 13px;">Accept Scrap & Pay ₹${finalPayable.toFixed(2)}</button>
        </div>
      </div>`;
    }).join('');

    document.querySelectorAll('.accept-scrap-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = (e.target as HTMLElement).getAttribute('data-id')!;
        if (id) {
          acceptScrap(id);
        }
      });
    });
  }
}

function renderCalculator() {
  currentViewName = 'calculator';
  let categoriesHTML = scrapCategories.map((item, index) =>
    `<div class="category-item" style="display:flex; justify-content: space-between; align-items:center; margin-bottom: 12px; padding: 10px; border: 1px solid #ddd; border-radius: 8px;"> 
      <div> 
        <span>${item.icon} <strong>${item.name}</strong></span> 
        <br><small>₹${item.rate} / kg</small> 
      </div> 
      <div> 
        <input type="number" id="weight-${index}" min="0" placeholder="0" style="width: 70px; padding: 6px; text-align: center;" /> kg 
      </div> 
    </div>`
  ).join('');

  app.innerHTML = `
  <div class="header"> 
    <button id="back-home-btn" class="back-btn">← Back</button> 
    <h2>Scrap Calculator</h2> 
  </div> 
  <div class="content"> 
    ${categoriesHTML} 
    <button id="proceed-booking-btn" class="btn primary-btn" style="margin-top: 15px;">Proceed to Booking</button> 
  </div>`;

  document.getElementById('back-home-btn')?.addEventListener('click', renderAppView);
  document.getElementById('proceed-booking-btn')?.addEventListener('click', () => {
    selectedItems = [];
    let totalEst = 0;

    scrapCategories.forEach((cat, index) => {
      const input = document.getElementById(`weight-${index}`) as HTMLInputElement;
      const weight = parseFloat(input?.value || '0');
      if (weight > 0) {
        selectedItems.push({ name: cat.name, weight: weight, rate: cat.rate });
        totalEst += weight * cat.rate;
      }
    });

    if (selectedItems.length === 0) {
      alert('Kripya kam se kam ek item ka weight enter karein.');
      return;
    }
    renderBookingForm(totalEst);
  });
}

function renderBookingForm(totalEst: number) {
  const defaultName = currentProfile?.full_name || '';
  const defaultPhone = currentProfile?.phone || '';
  const defaultAddress = currentProfile?.address || '';

  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const currentTimeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  const currentHHMM = now.toTimeString().slice(0, 5);

  const pickupCharge = totalEst >= 500 ? 0 : 50;
  const netEstimatedPayout = Math.max(0, totalEst - pickupCharge);

  let capturedLat: number | undefined = undefined;
  let capturedLng: number | undefined = undefined;

  app.innerHTML = `
  <div class="header">
    <button id="back-calc-btn" class="back-btn">← Back</button>
    <h2>Pickup Details</h2>
  </div>
  <div class="content">
    <div class="card" style="background: #f0fdf4; border-color: #bbf7d0;">
      <div style="display: flex; justify-content: space-between; font-size: 13px;">
        <span>Estimated Scrap Value:</span>
        <strong>₹${totalEst}</strong>
      </div>
      <div style="display: flex; justify-content: space-between; font-size: 13px; color: ${pickupCharge === 0 ? '#16a34a' : '#dc2626'}; margin-top: 4px;">
        <span>Delivery / Pickup Fee:</span>
        <strong>${pickupCharge === 0 ? 'FREE Pickup' : '-₹' + pickupCharge}</strong>
      </div>
      <div style="display: flex; justify-content: space-between; font-size: 15px; font-weight: bold; color: #15803d; margin-top: 6px; padding-top: 6px; border-top: 1px dashed #86efac;">
        <span>Net Amount You Receive:</span>
        <strong>₹${netEstimatedPayout}</strong>
      </div>
    </div>

    <form id="booking-form" style="margin-top: 15px;">
      <div style="background: #eff6ff; padding: 10px; border-radius: 8px; border: 1px solid #bfdbfe; margin-bottom: 12px;">
        <h5 style="margin: 0 0 4px 0; color: #1e40af; font-size: 13px;">⚡ Order Time (Auto Generated)</h5>
        <p style="font-size: 12px; color: #1d4ed8; margin-bottom: 8px;">Order Time: <strong>${todayStr} (${currentTimeStr})</strong></p>
        <div style="display: flex; gap: 8px;">
          <div style="flex: 1;">
            <label style="font-size: 11px; font-weight: bold; color: #1e3a8a;">Pickup Date</label>
            <input type="date" id="cust-pickup-date" value="${todayStr}" min="${todayStr}" required style="width: 100%; padding: 6px; font-size: 12px; margin-top: 2px; border: 1px solid #93c5fd; border-radius: 4px;" />
          </div>
          <div style="flex: 1;">
            <label style="font-size: 11px; font-weight: bold; color: #1e3a8a;">Pickup Time</label>
            <input type="time" id="cust-pickup-time" value="${currentHHMM}" required style="width: 100%; padding: 6px; font-size: 12px; margin-top: 2px; border: 1px solid #93c5fd; border-radius: 4px;" />
          </div>
        </div>
      </div>

      <div style="margin-bottom: 10px;">
        <label>Full Name *</label>
        <input type="text" id="cust-name" value="${defaultName}" required placeholder="Enter full name" style="width: 100%; padding: 8px; margin-top: 4px;" />
      </div>
      <div style="margin-bottom: 10px;">
        <label>Phone Number *</label>
        <input type="tel" id="cust-phone" value="${defaultPhone}" required placeholder="Enter 10-digit number" style="width: 100%; padding: 8px; margin-top: 4px;" />
      </div>
      <div style="margin-bottom: 10px;">
        <label>Pickup Address *</label>
        <textarea id="cust-address" required placeholder="Enter full home/office address" style="width: 100%; padding: 8px; margin-top: 4px;">${defaultAddress}</textarea>
      </div>
      <div style="margin-bottom: 10px;">
        <label>Shop / Buyer Name (Optional)</label>
        <input type="text" id="cust-shop-name" placeholder="Enter scrap shop or buyer name if any" style="width: 100%; padding: 8px; margin-top: 4px;" />
      </div>
      <div style="margin-bottom: 10px;">
        <label>Pickup Location (Optional GPS)</label>
        <div style="display: flex; gap: 8px; align-items: center; margin-top: 4px;">
          <button type="button" id="use-location-btn" class="btn" style="padding: 8px 12px; background: #e0f2fe; color: #0369a1; border: 1px solid #bae6fd; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 13px;">
            📍 Use Current Location
          </button>
          <span id="location-status" style="font-size: 12px; color: #666;"></span>
        </div>
      </div>
      <div style="margin-bottom: 10px;">
        <label>Landmark (Optional)</label>
        <input type="text" id="cust-landmark" placeholder="Near Temple, Opposite School, etc." style="width: 100%; padding: 8px; margin-top: 4px;" />
      </div>
      <div id="form-error-msg" style="color: #dc2626; font-size: 13px; font-weight: bold; margin-top: 6px; display: none;"></div>
      <button type="submit" id="submit-booking-btn" class="btn primary-btn" style="width: 100%; margin-top: 10px;">Confirm Booking</button>
    </form>
  </div>`;

  document.getElementById('back-calc-btn')?.addEventListener('click', renderCalculator);

  const locBtn = document.getElementById('use-location-btn');
  const locStatus = document.getElementById('location-status');

  if ('permissions' in navigator && navigator.permissions) {
    navigator.permissions.query({ name: 'geolocation' }).then((result) => {
      if (result.state === 'granted') {
        getCurrentLocation().then(coords => {
          capturedLat = coords.latitude;
          capturedLng = coords.longitude;
          if (locStatus) {
            locStatus.textContent = 'Location attached ✓';
            locStatus.style.color = '#16a34a';
          }
        }).catch(() => {});
      }
    }).catch(() => {});
  }

  locBtn?.addEventListener('click', async () => {
    if (locStatus) locStatus.textContent = 'Fetching location...';
    try {
      const coords = await getCurrentLocation();
      capturedLat = coords.latitude;
      capturedLng = coords.longitude;
      if (locStatus) {
        locStatus.textContent = 'Location saved ✓';
        locStatus.style.color = '#16a34a';
      }
    } catch (err: any) {
      console.warn('Geolocation failed:', err);
      capturedLat = undefined;
      capturedLng = undefined;
      if (locStatus) {
        locStatus.textContent = 'Location unavailable (manual address will be used)';
        locStatus.style.color = '#dc2626';
      }
    }
  });

  document.getElementById('booking-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const submitBtn = document.getElementById('submit-booking-btn') as HTMLButtonElement;
    const errorContainer = document.getElementById('form-error-msg') as HTMLDivElement;
    if (errorContainer) {
      errorContainer.style.display = 'none';
      errorContainer.textContent = '';
    }
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting Booking...';
    }

    const pickupDate = (document.getElementById('cust-pickup-date') as HTMLInputElement).value || todayStr;
    const pickupTime = (document.getElementById('cust-pickup-time') as HTMLInputElement).value || currentTimeStr;
    const name = (document.getElementById('cust-name') as HTMLInputElement).value;
    const phone = (document.getElementById('cust-phone') as HTMLInputElement).value;
    const address = (document.getElementById('cust-address') as HTMLInputElement).value;
    const shopName = (document.getElementById('cust-shop-name') as HTMLInputElement).value.trim();
    const landmark = (document.getElementById('cust-landmark') as HTMLInputElement).value.trim();

    try {
      const bookingResult = await submitBookingToBackend({
        customer_name: name,
        customer_phone: phone,
        customer_address: address,
        shop_name: shopName || undefined,
        pickup_date: pickupDate,
        pickup_time: pickupTime,
        landmark: landmark || undefined,
        latitude: capturedLat,
        longitude: capturedLng,
        items: selectedItems,
        estimated_amount: totalEst
      });
      renderSuccess(bookingResult);
    } catch (err: any) {
      if (errorContainer) {
        errorContainer.textContent = `❌ ${err.message || 'Error submitting booking. Please try again.'}`;
        errorContainer.style.display = 'block';
      }
      alert(`Booking Failed: ${err.message || 'Could not save booking to database.'}`);
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Confirm Booking';
      }
    }
  });
}

function renderSuccess(booking: Booking) {
  const pickupCharge = booking.pickup_charge ?? (booking.estimated_amount >= 500 ? 0 : 50);
  const pickupChargeText = pickupCharge === 0 ? 'FREE Pickup' : `-₹${pickupCharge}`;
  const netPayout = Math.max(0, (booking.estimated_amount || 0) - pickupCharge);

  app.innerHTML = `
  <div class="header">
    <h2>Booking Confirmed! 🎉</h2>
  </div>
  <div class="content">
    <div class="card" style="text-align: center;">
      <div style="font-size: 50px;">✅</div>
      <h3 style="margin: 10px 0 5px 0;">Code: ${booking.booking_code}</h3>
      <p style="font-size: 12px; color: #666; margin-bottom: 12px;">🕒 Order Placed: ${formatDateTime(booking.created_at)}</p>

      <div style="background: #eff6ff; padding: 10px; border-radius: 8px; border: 1px solid #bfdbfe; margin-bottom: 12px; font-size: 13px; color: #1e40af;">
        📅 <strong>Scheduled Pickup:</strong> ${booking.pickup_date || 'N/A'} at ${booking.pickup_time || 'N/A'}
      </div>

      <div style="background: #f8fafc; padding: 12px; border-radius: 8px; border: 1px solid #e2e8f0; font-size: 13px;">
        <div style="display: flex; justify-content: space-between; padding: 3px 0;">
          <span>Estimated Scrap Value:</span>
          <strong>₹${booking.estimated_amount}</strong>
        </div>
        <div style="display: flex; justify-content: space-between; padding: 3px 0; color: ${pickupCharge === 0 ? '#16a34a' : '#dc2626'}; font-weight: 600;">
          <span>Delivery / Pickup Fee:</span>
          <span>${pickupChargeText}</span>
        </div>
        <div style="display: flex; justify-content: space-between; padding: 6px 0 2px 0; margin-top: 6px; border-top: 1px dashed #cbd5e1; font-weight: bold; font-size: 14px; color: #15803d;">
          <span>Net Amount You Receive:</span>
          <span>₹${netPayout}</span>
        </div>
      </div>

      ${booking.shop_name ? `
      <div style="margin-top: 10px; font-size: 12px; color: #0369a1; background: #e0f2fe; padding: 8px; border-radius: 6px;">
        🏪 <strong>Preferred Shop / Buyer:</strong> ${booking.shop_name}
      </div>
      ` : ''}
      <p style="margin-top: 12px; font-size: 13px; text-align: center;">Status: <span style="color: green; font-weight: bold;">${booking.status}</span></p>
    </div>
    <button id="go-home-btn" class="btn primary-btn" style="margin-top: 20px;">Go to Home</button>
  </div>`;

  document.getElementById('go-home-btn')?.addEventListener('click', renderAppView);
}

async function renderOrders() {
  currentViewName = 'orders';
  app.innerHTML = `
  <div class="header"> 
    <div style="display: flex; justify-content: space-between; align-items: center;"> 
      <button id="back-home-btn" class="back-btn">← Back</button> 
      <button id="refresh-orders-btn" style="background: #ffffff; color: #16a34a; border: 1px solid #16a34a; padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: bold; cursor: pointer;"> 🔄 Refresh </button> 
    </div> 
    <h2 style="margin-top: 10px;">My Bookings & Track</h2> 
  </div> 
  <div class="content"> 
    <p style="text-align: center; color: #666; margin: 20px 0;">Loading your bookings...</p> 
  </div>`;

  document.getElementById('back-home-btn')?.addEventListener('click', () => {
    currentViewName = 'home';
    renderAppView();
  });
  document.getElementById('refresh-orders-btn')?.addEventListener('click', renderOrders);

  const { orders, error } = await fetchUserOrders();
  const contentDiv = document.querySelector('.content')!;

  let errorBannerHTML = '';
  if (error) {
    errorBannerHTML = `<div style="background: #fffbebfb; border: 1px solid #fef3c7; border-left: 4px solid #f59e0b; padding: 10px 12px; border-radius: 6px; margin-bottom: 12px; font-size: 12px; color: #b45309; display: flex; justify-content: space-between; align-items: center;"> <span>⚠️ ${error}</span> <button id="retry-orders-btn" style="background: #f59e0b; color: white; border: none; padding: 4px 8px; border-radius: 4px; font-size: 11px; cursor: pointer; font-weight: bold;">Retry</button> </div>`;
  }

  if (orders.length === 0) {
    contentDiv.innerHTML = `${errorBannerHTML} 
    <div class="card" style="text-align: center; padding: 25px 15px;"> 
      <div style="font-size: 40px; margin-bottom: 10px;">📦</div> 
      <h3 style="margin-bottom: 6px; color: #374151;">No bookings yet</h3> 
      <p style="font-size: 13px; color: #6b7280; margin-bottom: 16px;">Book a scrap pickup to get started.</p> 
      <button id="book-new-pickup-btn" class="btn primary-btn" style="padding: 10px 20px; width: auto; font-size: 14px;">Book Pickup Now</button> 
    </div>`;

    document.getElementById('book-new-pickup-btn')?.addEventListener('click', renderCalculator);
    document.getElementById('retry-orders-btn')?.addEventListener('click', renderOrders);
    return;
  }

  const ordersHTML = orders.map(order => {
    const formattedDate = formatDateTime(order.created_at);

    const itemsSummaryHTML = (order.items || []).map(item => 
      `<div style="display: flex; justify-content: space-between; font-size: 12px; color: #4b5563; padding: 2px 0;"> 
        <span>• ${item.name} (${typeof item.actual_weight === 'number' ? item.actual_weight + ' kg actual' : item.weight + ' kg est.'})</span> 
        <span>₹${(typeof item.actual_weight === 'number' ? item.actual_weight : item.weight) * item.rate}</span> 
      </div>`
    ).join('');

    const pickupCharge = order.pickup_charge ?? (order.estimated_amount >= 500 ? 0 : 50);
    const netEstimatedPayout = Math.max(0, order.estimated_amount - pickupCharge);
    const actual = order.actual_amount;
    const netActualPayout = typeof actual === 'number' ? Math.max(0, actual - pickupCharge) : undefined;
    const isDeletable = ['Completed', 'Cancelled'].includes(order.status);

    return `
    <div class="card" style="margin-bottom: 16px; border-left: 4px solid #16a34a;"> 
      <div style="display: flex; justify-content: space-between; align-items: flex-start;"> 
        <div> 
          <strong style="font-size: 15px; color: #111827;">${order.booking_code}</strong> 
          <div style="font-size: 11px; color: #6b7280; margin-top: 2px;">🕒 Order Placed: <strong>${formattedDate}</strong></div> 
          ${(order.pickup_date || order.pickup_time) ? `<div style="font-size: 12px; color: #2563eb; font-weight: bold; margin-top: 3px;">⏰ Scheduled Slot: ${order.pickup_date || ''} (${order.pickup_time || ''})</div>` : ''} 
        </div> 
        <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 4px;"> 
          <span style="font-size: 11px; font-weight: 700; padding: 3px 8px; background: #dcfce7; color: #15803d; border-radius: 12px; text-transform: uppercase;"> ${order.status} </span> 
          ${isDeletable ? `<button class="btn delete-order-btn" data-id="${order.id || ''}" data-code="${order.booking_code}" style="background: #ef4444; color: white; border: none; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; cursor: pointer;">🗑 Delete</button>` : ''}
        </div>
      </div>

      <div style="margin-top: 10px; font-size: 12px; color: #374151; background: #f9fafb; padding: 8px 10px; border-radius: 6px; border: 1px solid #f3f4f6;">
        <div>📍 <strong>Pickup Address:</strong> ${order.customer_address}</div>
        ${order.landmark ? `<div style="margin-top: 3px; color: #4b5563;">🏢 <strong>Landmark:</strong> ${order.landmark}</div>` : ''}
        ${order.shop_name ? `<div style="margin-top: 3px; color: #0369a1; font-weight: 600;">🏪 <strong>Shop / Buyer:</strong> ${order.shop_name}</div>` : ''}
        ${(order.latitude != null && order.longitude != null) ? `<div style="margin-top: 4px;"><a href="https://maps.google.com/?q=${order.latitude},${order.longitude}" target="_blank" rel="noopener noreferrer" style="color: #2563eb; text-decoration: none; font-weight: 600;">📍 View Location on Map</a></div>` : ''}
      </div>

      ${order.items && order.items.length > 0 ? `<div style="margin-top: 10px;"> <div style="font-size: 11px; font-weight: 700; color: #6b7280; text-transform: uppercase; margin-bottom: 4px;">Scrap Items</div> ${itemsSummaryHTML} </div>` : ''}

      ${order.scrap_photo_url ? `<div style="margin-top: 10px; padding: 6px; background: #f0fdf4; border-radius: 6px; border: 1px solid #bbf7d0;"> <div style="font-size: 11px; font-weight: bold; color: #16a34a; margin-bottom: 4px;">📷 Collected Scrap Verification Photo:</div> <img src="${order.scrap_photo_url}" alt="Collected Scrap" style="max-width: 100%; max-height: 180px; object-fit: contain; border-radius: 6px; border: 1px solid #cbd5e1;" /> </div>` : ''}

      <div style="margin-top: 10px; padding-top: 8px; border-top: 1px dashed #e5e7eb; font-size: 12px;">
        <div style="display: flex; justify-content: space-between; color: #6b7280;">
          <span>Estimated Scrap Value:</span>
          <span>₹${order.estimated_amount}</span> 
        </div> 
        <div style="display: flex; justify-content: space-between; color: #dc2626; margin-top: 2px;"> 
          <span>Delivery / Pickup Fee:</span> 
          <span>-${pickupCharge === 0 ? 'FREE' : '₹' + pickupCharge}</span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-top: 4px; font-weight: bold; color: #16a34a; font-size: 13px;">
          <span>Estimated Net Payout:</span>
          <span>₹${netEstimatedPayout}</span>
        </div>
      </div>
      ${typeof netActualPayout === 'number' ? `<div style="margin-top: 6px; padding-top: 6px; border-top: 1px dashed #e5e7eb; font-size: 12px; background: #f0fdf4; padding: 6px; border-radius: 4px;"> <div style="display: flex; justify-content: space-between; color: #16a34a;"> <span>Actual Scrap Value Collected:</span> <strong>₹${actual}</strong> </div> <div style="display: flex; justify-content: space-between; color: #15803d; font-weight: bold; margin-top: 3px; font-size: 13px;"> <span>Final Cash Paid to You:</span> <span>₹${netActualPayout.toFixed(2)}</span> </div> </div>` : ''}

      ${renderStatusTimeline(order.status)}
    </div>`;
  }).join('');

  contentDiv.innerHTML = errorBannerHTML + ordersHTML;
  document.getElementById('retry-orders-btn')?.addEventListener('click', renderOrders);

  document.querySelectorAll('.delete-order-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = (e.currentTarget as HTMLElement).getAttribute('data-id');
      const code = (e.currentTarget as HTMLElement).getAttribute('data-code');
      deleteBooking(id || undefined, code || undefined, true);
    });
  });
}

// Start application
initApp();