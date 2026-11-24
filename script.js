
// LORA Café - Menu Search

const searchInput = document.getElementById("menuSearch");
const menuCards = document.querySelectorAll(".menu-card");
const noResults = document.getElementById("noResults");

if (searchInput) {
  searchInput.addEventListener("input", () => {
    const searchValue = searchInput.value.toLowerCase().trim();
    let visibleCount = 0;

    menuCards.forEach((card) => {
      const name = card.dataset.name.toLowerCase();
      const visible = name.includes(searchValue);

      card.style.display = visible ? "" : "none";

      if (visible) visibleCount++;
    });

    if (noResults) {
      noResults.hidden = visibleCount !== 0;
    }
  });
}

// LORA Café - Shopping Cart

let cart = [];

const cartItems = document.getElementById("cartItems");
const cartTotal = document.getElementById("cartTotal");
const clearCart = document.getElementById("clearCart");
const orderBtn = document.getElementById("orderBtn");

function renderCart() {
  if (!cartItems || !cartTotal) return;

  if (cart.length === 0) {
    cartItems.innerHTML =
      '<p class="empty-cart">Your cart is waiting for something delicious.</p>';
  } else {
    cartItems.innerHTML = cart.map((item, index) => `
      <div class="cart-item">
        <span>${item.name} - EGP ${item.price}</span>
        <button type="button" data-remove="${index}">Remove</button>
      </div>
    `).join("");
  }

  const total = cart.reduce((sum, item) => sum + item.price, 0);
  cartTotal.textContent = `EGP ${total}`;
}

document.querySelectorAll(".add-btn").forEach((button) => {
  button.addEventListener("click", () => {
    cart.push({
      name: button.dataset.name,
      price: Number(button.dataset.price)
    });

    renderCart();
  });
});

if (cartItems) {
  cartItems.addEventListener("click", (event) => {
    const removeButton = event.target.closest("[data-remove]");

    if (!removeButton) return;

    const index = Number(removeButton.dataset.remove);
    cart.splice(index, 1);
    renderCart();
  });
}

if (clearCart) {
  clearCart.addEventListener("click", () => {
    cart = [];
    renderCart();
  });
}

if (orderBtn) {
  orderBtn.addEventListener("click", () => {
    if (cart.length === 0) {
      alert("Please add an item to your cart first.");
      return;
    }

    alert("Your selection is ready! Online ordering will be connected soon.");
  });
}

renderCart();
